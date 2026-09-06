/**
 * Sync pipeline: Extract -> Validate -> Normalize -> Batch -> Upload -> Verify
 * -> Commit (PROJECT_SPEC section 10).
 *
 * Everything is written to the offline queue before it is uploaded, so a
 * network outage or a crash only delays delivery - it never loses data.
 */
import type { AgentConfigResponse, DrugUsageRecord } from "@shared/canonical";

import {
  AGENT_VERSION,
  dataDir,
  loadState,
  loadStatus,
  machineHostname,
  type AgentStatus,
  requireCredential,
  saveState,
  writeStatus,
  type AgentCredentialFile,
} from "./config";
import { CentralApiError, CentralClient, withRetry } from "./central/client";
import { JhcisConnection } from "./jhcis/connection";
import { UsageExtractor } from "./jhcis/extractor";
import { SchemaInspector, type SchemaMapping } from "./jhcis/schema-inspector";
import { log } from "./logger";
import { OfflineQueue } from "./queue/queue";
import { resolveNetworkIdentity } from "./network";

export type SyncMode = "INITIAL" | "INCREMENTAL" | "MANUAL_RANGE" | "RETRY";

const EXTRACT_PAGE_SIZE = 500;
/** Kept in step with the server's UPLOAD_CHUNK_SIZE. */
const DEFAULT_CHUNK_SIZE = 500;
/** Upload once this many chunks are waiting, so progress is visible early. */
const UPLOAD_EVERY_CHUNKS = 10;

export interface SyncOptions {
  mode: SyncMode;
  from?: string | null;
  to?: string | null;
  /** extract and queue, but do not upload (used by `doctor --dry-run`) */
  dryRun?: boolean;
  /**
   * Count both sides afterwards and repair the difference (default true).
   * Set false for the repair runs themselves, so they cannot recurse.
   */
  reconcile?: boolean;
  /**
   * Compare monthly row counts with Central first and read only the months
   * that differ (default true). Set false when the range must be read
   * whatever the counts say - a repair run, or an operator asking for a
   * specific window because they believe what is stored there is wrong.
   */
  skipMatchingMonths?: boolean;
}

/** What the after-sync count found. */
export interface Reconciliation {
  /** rows JHCIS holds in the window */
  expected: number;
  /** rows the central database holds in the same window */
  central: number;
  /** rows the central server refused, with a reason recorded */
  rejected: number;
  /** rows still unaccounted for after the repair pass */
  gap: number;
  repairedRows: number;
  repairedMonths: string[];
}

export interface SyncResult {
  batchRef: string;
  mode: SyncMode;
  rangeFrom: string;
  rangeTo: string;
  recordsRead: number;
  recordsSent: number;
  accepted: number;
  rejected: number;
  pendingChunks: number;
  /** null when the run was a dry run or a repair pass */
  reconciliation: Reconciliation | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nextBatchRef(): string {
  const state = loadState();
  const sequence = state.batchSequence + 1;
  saveState({ ...state, batchSequence: sequence });
  const stamp = today().replace(/-/g, "");
  return `SYNC-${stamp}-${String(sequence).padStart(6, "0")}`;
}

/**
 * Resolves the date window.
 * Incremental re-reads the last `reprocessDays` days because JHCIS
 * visitdrug.dateupdate is not a reliable change marker on V5.1 - a row keyed
 * late would otherwise be missed. Re-reading is safe: the central server keys
 * every row deterministically and upserts.
 */
export function resolveRange(
  mode: SyncMode,
  credential: AgentCredentialFile,
  bounds: { min: string | null; max: string | null },
  explicit: { from?: string | null; to?: string | null },
): { from: string; to: string } {
  const to = explicit.to ?? bounds.max ?? today();

  if (mode === "MANUAL_RANGE") {
    if (!explicit.from) throw new Error("MANUAL_RANGE requires --from");
    return { from: explicit.from, to };
  }
  if (mode === "INITIAL") {
    return { from: explicit.from ?? bounds.min ?? shiftDays(to, -365), to };
  }

  const state = loadState();
  const watermark = state.lastSyncedVisitDate;
  if (!watermark) return { from: bounds.min ?? shiftDays(to, -365), to };
  return { from: shiftDays(watermark, -credential.reprocessDays), to };
}

export class SyncRunner {
  private readonly credential = requireCredential();
  private readonly client = new CentralClient(this.credential.centralApiUrl, this.credential);
  private readonly queue = new OfflineQueue(dataDir());

  /**
   * Status fields recording that the Central API just answered us. Only ever
   * called after a request came back, because that is the only thing proving
   * the link works: signed, accepted, replied to.
   */
  private centralAck(): Partial<AgentStatus> {
    const now = new Date().toISOString();
    return { centralState: "CONNECTED", centralConnected: true, centralAttemptAt: now, centralAckAt: now };
  }

  /**
   * Status fields recording that it did not. 401/403 is kept apart from
   * everything else because the two need different people: a network error
   * clears up on its own or is the clinic's internet, an auth error means this
   * machine's credential is no longer accepted. centralAckAt is left alone -
   * it still says when the link last genuinely worked.
   */
  private centralFailure(error: unknown): Partial<AgentStatus> {
    const status = error instanceof CentralApiError ? error.status : 0;
    const auth = status === 401 || status === 403;
    return {
      centralState: auth ? "AUTH_ERROR" : "NETWORK_ERROR",
      centralConnected: false,
      centralAttemptAt: new Date().toISOString(),
    };
  }

  /** Uploads everything still sitting in the queue (called on every run). */
  async flushQueue(): Promise<{ accepted: number; rejected: number; remaining: number }> {
    let accepted = 0;
    let rejected = 0;

    for (const chunk of this.queue.list("PENDING")) {
      try {
        const result = await withRetry(
          () =>
            this.client.upload({
              batchRef: chunk.batchRef,
              pcucode: chunk.pcucode,
              sourceVersion: chunk.sourceVersion,
              records: chunk.records,
            }),
          { label: `upload ${chunk.batchRef}#${chunk.sequence}` },
        );
        accepted += result.accepted;
        rejected += result.rejected;
        const before = loadStatus();
        writeStatus({
          phase: "uploading",
          syncPhase: "UPLOADING",
          // uploaded is what left this machine; accepted and rejected are what
          // Central said it did with them. Conflating the two is how a screen
          // claims rows arrived that were actually refused.
          uploaded: before.uploaded + chunk.records.length,
          recordsUploaded: before.recordsUploaded + chunk.records.length,
          recordsAccepted: before.recordsAccepted + result.accepted,
          recordsRejected: before.recordsRejected + result.rejected,
          pendingChunks: this.queue.count("PENDING"),
          lastProgressAt: new Date().toISOString(),
          ...this.centralAck(),
        });
        if (result.rejects.length) {
          log.warn("central rejected records", {
            batchRef: chunk.batchRef,
            sample: result.rejects.slice(0, 3),
          });
        }
        this.queue.ack(chunk);
      } catch (error) {
        const permanent = error instanceof CentralApiError && error.permanent;
        const message = error instanceof Error ? error.message : String(error);
        this.queue.fail(chunk, message, permanent);
        log.error("chunk upload failed", {
          batchRef: chunk.batchRef,
          sequence: chunk.sequence,
          permanent,
          error: message,
        });
        // A failed upload is never evidence of a working link. This used to be
        // `centralConnected: !permanent`, which called every retryable failure
        // - a timeout, a reset connection, DNS failing - a successful
        // connection, so the tray said "เชื่อมต่อแล้ว" precisely when nothing
        // was getting through.
        writeStatus({
          phase: "error",
          syncPhase: "ERROR",
          lastError: message,
          pendingChunks: this.queue.count("PENDING"),
          ...this.centralFailure(error),
        });
        if (!permanent) break; // network is down - stop and retry on the next run
      }
    }

    return { accepted, rejected, remaining: this.queue.count("PENDING") };
  }

  /**
   * Delivers chunks that can no longer be uploaded under their original batch
   * (the server closed it, or it never existed) by re-filing them under a new
   * RETRY batch. Without this, a run interrupted at the wrong moment leaves
   * rows parked in failed/ that no amount of retrying can move.
   */
  async recoverOrphanChunks(): Promise<{ recovered: number; batchRef: string | null }> {
    const stuck = this.queue.list("FAILED");
    if (!stuck.length) return { recovered: 0, batchRef: null };

    const pcucode = stuck[0].pcucode;
    const dates = stuck
      .flatMap((chunk) => chunk.records.map((record) => record.usageDate))
      .filter(Boolean)
      .sort();
    const records = stuck.reduce((sum, chunk) => sum + chunk.records.length, 0);
    const batchRef = nextBatchRef();

    await withRetry(
      () =>
        this.client.startSync({
          batchRef,
          mode: "RETRY",
          rangeFrom: dates[0] ?? null,
          rangeTo: dates[dates.length - 1] ?? null,
          pcucode,
          recordsRead: records,
        }),
      { label: "recovery batch" },
    );

    let sequence = 0;
    for (const chunk of stuck) this.queue.rehome(chunk, batchRef, ++sequence);

    const flushed = await this.flushQueue();
    await withRetry(
      () =>
        this.client.completeSync({
          batchRef,
          status: flushed.remaining === 0 ? "COMPLETED" : "FAILED",
          recordsRead: records,
          recordsSent: records,
          lastVisitDate: null,
          errorMessage: flushed.remaining ? `ยังค้าง ${flushed.remaining} ชุด` : null,
        }),
      { label: "recovery complete" },
    );

    log.info("recovered orphaned chunks", { batchRef, chunks: stuck.length, records });
    return { recovered: records, batchRef };
  }

  async run(options: SyncOptions): Promise<SyncResult> {
    const db = new JhcisConnection();
    try {
      const inspector = new SchemaInspector(db);
      const { report, mapping } = await inspector.inspect();

      if (!mapping) {
        throw new Error(
          `JHCIS schema ไม่รองรับการดึงข้อมูลการจ่ายยา: ${report.warnings.join("; ")}`,
        );
      }
      const pcucode = report.pcucode;
      if (!pcucode) throw new Error("ไม่สามารถอ่าน pcucode จาก JHCISDB ได้ (office.offid)");
      if (pcucode !== this.credential.expectedPcucode) {
        throw new Error(
          `pcucode ของ JHCISDB (${pcucode}) ไม่ตรงกับสถานบริการที่ลงทะเบียนไว้ (${this.credential.expectedPcucode})`,
        );
      }

      const extractor = new UsageExtractor(db, mapping);
      const [min, max] = await Promise.all([
        extractor.minUsageDate(pcucode),
        extractor.maxUsageDate(pcucode),
      ]);
      const requested = resolveRange(options.mode, this.credential, { min, max }, options);
      const sourceVersion = report.jhcisVersion ?? report.mysqlVersion;

      // Read only what the centre is missing.
      //
      // An incremental run re-reads reprocessDays behind the watermark every
      // time, to catch visits keyed in late. On an hourly schedule that is the
      // same week of rows extracted from JHCIS and pushed over the wire again
      // and again, almost always to be discarded centrally as duplicates -
      // load on the รพ.สต. server for nothing.
      //
      // Comparing row counts per month first is two cheap queries, and when
      // they agree there is nothing to do at all. Only the months that differ
      // are read, and the range is narrowed to span just those.
      // Only an INCREMENTAL run may skip: it is the one that repeats on a
      // schedule and re-reads the same days. A range someone asked for
      // explicitly - MANUAL_RANGE, a repair, a first full read - is read as
      // asked, because the reason for asking is usually that what is stored
      // for those days is not trusted, and counts alone would not show that.
      const maySkip = options.skipMatchingMonths ?? options.mode === "INCREMENTAL";
      const range = maySkip
        ? await this.narrowToMissing(extractor, pcucode, requested)
        : requested;

      if (!range) {
        log.info("ไม่มีอะไรต้องดึง ข้อมูลที่ศูนย์กลางตรงกับ JHCIS แล้ว", {
          from: requested.from,
          to: requested.to,
        });
        writeStatus({
          phase: "done",
          message: `ข้อมูลตรงกันแล้ว (${requested.from} ถึง ${requested.to}) ไม่ต้องดึงซ้ำ`,
          total: 0,
          extracted: 0,
          uploaded: 0,
          pendingChunks: this.queue.count("PENDING"),
          jhcisConnected: true,
          lastError: null,
          syncPhase: "SUCCESS",
          jhcisState: "CONNECTED",
          jhcisCheckedAt: new Date().toISOString(),
          rangeFrom: requested.from,
          rangeTo: requested.to,
          recordsExpected: 0,
          recordsExtracted: 0,
          recordsQueued: 0,
          recordsUploaded: 0,
          recordsAccepted: 0,
          recordsRejected: 0,
          lastProgressAt: new Date().toISOString(),
        });
        const flushed = await this.flushQueue();
        return {
          batchRef: "",
          mode: options.mode,
          rangeFrom: requested.from,
          rangeTo: requested.to,
          recordsRead: 0,
          recordsSent: 0,
          accepted: flushed.accepted,
          rejected: flushed.rejected,
          pendingChunks: flushed.remaining,
          reconciliation: null,
        };
      }

      const recordsRead = await extractor.countUsage(pcucode, range.from, range.to);
      const batchRef = nextBatchRef();

      writeStatus({
        phase: "starting",
        message: `เตรียมซิงก์ ${range.from} ถึง ${range.to}`,
        total: recordsRead,
        extracted: 0,
        uploaded: 0,
        batchRef,
        jhcisConnected: true,
        lastError: null,
        // Published before a single row is read, so a screen can say which
        // days are being worked on instead of showing a bar with no subject,
        // and every counter starts from zero for this run rather than
        // carrying the previous one's totals.
        syncPhase: "READING",
        jhcisState: "CONNECTED",
        jhcisCheckedAt: new Date().toISOString(),
        rangeFrom: range.from,
        rangeTo: range.to,
        recordsExpected: recordsRead,
        recordsExtracted: 0,
        recordsQueued: 0,
        recordsUploaded: 0,
        recordsAccepted: 0,
        recordsRejected: 0,
        syncStartedAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
      });

      log.info("sync starting", {
        batchRef,
        mode: options.mode,
        from: range.from,
        to: range.to,
        recordsRead,
      });

      if (!options.dryRun) {
        await withRetry(
          () =>
            this.client.startSync({
              batchRef,
              mode: options.mode,
              rangeFrom: range.from,
              rangeTo: range.to,
              pcucode,
              recordsRead,
            }),
          { label: "sync start" },
        );
      }

      // 1. Extract + queue. Nothing is uploaded before it is durable on disk.
      let sequence = 0;
      let recordsSent = 0;
      let buffer: DrugUsageRecord[] = [];

      const flushBuffer = () => {
        if (!buffer.length) return;
        this.queue.enqueue({
          batchRef,
          sequence: ++sequence,
          pcucode,
          sourceVersion,
          records: buffer,
        });
        recordsSent += buffer.length;
        buffer = [];
        writeStatus({
          phase: "extracting",
          syncPhase: "READING",
          extracted: recordsSent,
          total: recordsRead,
          recordsExtracted: recordsSent,
          // Queued, not merely read: the chunk is durable on disk by now.
          recordsQueued: recordsSent,
          lastProgressAt: new Date().toISOString(),
        });
      };

      for await (const page of extractor.streamUsage(
        pcucode,
        range.from,
        range.to,
        EXTRACT_PAGE_SIZE,
      )) {
        for (const record of page) {
          buffer.push(record);
          if (buffer.length >= DEFAULT_CHUNK_SIZE) flushBuffer();
        }

        // Upload as we go instead of queueing the whole history first: a full
        // sync is a quarter of a million rows, and waiting for extraction to
        // finish would leave the operator staring at a bar that never moves -
        // and would lose everything already read if the machine restarted.
        if (!options.dryRun && this.queue.count("PENDING") >= UPLOAD_EVERY_CHUNKS) {
          await this.flushQueue();
        }
      }
      flushBuffer();

      if (options.dryRun) {
        log.info("dry run - chunks queued but not uploaded", { batchRef, chunks: sequence });
        return {
          batchRef,
          mode: options.mode,
          rangeFrom: range.from,
          rangeTo: range.to,
          recordsRead,
          recordsSent,
          accepted: 0,
          rejected: 0,
          pendingChunks: this.queue.count("PENDING"),
          reconciliation: null,
        };
      }

      // 2. Drug master, the whole of cdrug in pages. A failure here must NOT
      // abort the run: the usage rows are already durable in the queue, and the
      // master is re-sent every sync.
      let masterSent = 0;
      try {
        for await (const page of extractor.streamDrugMaster()) {
          await withRetry(
            () =>
              this.client.upload({
                batchRef,
                pcucode,
                sourceVersion,
                drugs: page,
                records: [],
              }),
            { label: "upload drug master" },
          );
          masterSent += page.length;
        }
        log.info("drug master uploaded", { batchRef, drugs: masterSent });
      } catch (error) {
        log.warn("drug master upload failed - continuing with usage records", {
          batchRef,
          sent: masterSent,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 3. Upload every queued chunk (including leftovers from earlier runs).
      const flushed = await this.flushQueue();

      // 4. Count both sides before calling the run a success.
      //
      // Every step so far can report success and still leave a hole: a dropped
      // connection between chunks, a chunk the server refused for a reason the
      // agent treated as permanent, a PC restarted mid-run. Comparing the row
      // count JHCIS has for this window with what the central database ended up
      // holding is the only check that actually proves nothing was lost.
      let reconciliation: Reconciliation | null = null;
      if (options.reconcile !== false && !options.dryRun && flushed.remaining === 0) {
        reconciliation = await this.reconcile({
          extractor,
          pcucode,
          from: range.from,
          to: range.to,
          expected: recordsRead,
          rejected: flushed.rejected,
        });
      }

      const complete =
        flushed.remaining === 0 && (reconciliation === null || reconciliation.gap === 0);
      await withRetry(
        () =>
          this.client.completeSync({
            batchRef,
            status: complete ? "COMPLETED" : "FAILED",
            recordsRead,
            recordsSent,
            lastVisitDate: complete ? range.to : null,
            errorMessage: complete
              ? null
              : flushed.remaining
                ? `ยังมี ${flushed.remaining} chunk ที่อัปโหลดไม่สำเร็จ`
                : `ตรวจสอบหลังซิงก์: JHCIS ${reconciliation?.expected ?? 0} รายการ ` +
                  `แต่ศูนย์กลางมี ${reconciliation?.central ?? 0} รายการ ` +
                  `(ขาด ${reconciliation?.gap ?? 0})`,
          }),
        { label: "sync complete" },
      );

      if (complete) {
        const state = loadState();
        saveState({
          ...state,
          lastSyncedVisitDate: range.to,
          lastSyncAt: new Date().toISOString(),
        });
      }

      writeStatus({
        phase: complete ? "done" : "error",
        message: complete
          ? `ซิงก์สำเร็จและตรวจสอบครบ ${recordsSent.toLocaleString("th-TH")} รายการ`
          : flushed.remaining
            ? `ยังมี ${flushed.remaining} ชุดข้อมูลที่ส่งไม่สำเร็จ`
            : `ตรวจสอบแล้วยังขาด ${reconciliation?.gap ?? 0} รายการ`,
        syncPhase: complete ? "SUCCESS" : "ERROR",
        pendingChunks: flushed.remaining,
        lastSyncAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
        lastError: complete ? null : "อัปโหลดไม่ครบ",
      });

      log.info("sync finished", {
        batchRef,
        recordsRead,
        recordsSent,
        accepted: flushed.accepted,
        rejected: flushed.rejected,
        pending: flushed.remaining,
        reconciliation,
      });

      return {
        batchRef,
        mode: options.mode,
        rangeFrom: range.from,
        rangeTo: range.to,
        recordsRead,
        recordsSent,
        accepted: flushed.accepted,
        rejected: flushed.rejected,
        pendingChunks: flushed.remaining,
        reconciliation,
      };
    } finally {
      await db.close();
    }
  }

  /**
   * Counts the window on both sides and repairs the difference once.
   *
   * A remaining gap that matches the rows the server rejected is not a loss -
   * those rows exist in JHCIS but cannot be stored (an empty drugcode, for
   * example) and their reasons are recorded in sync_rejects. Anything else is
   * reported as a real gap so the batch is not marked successful.
   */
  private async reconcile(input: {
    extractor: UsageExtractor;
    pcucode: string;
    from: string;
    to: string;
    expected: number;
    rejected: number;
  }): Promise<Reconciliation> {
    const countCentral = async (): Promise<number> => {
      const audit = await withRetry(
        () => this.client.audit({ pcucode: input.pcucode, from: input.from, to: input.to }),
        { label: "post-sync audit" },
      );
      return audit.months.reduce((sum, month) => sum + month.rows, 0);
    };

    writeStatus({ message: "กำลังตรวจสอบความครบถ้วนหลังซิงก์" });

    let central = await countCentral();
    const repairedMonths: string[] = [];
    let repairedRows = 0;

    if (central < input.expected) {
      // Narrow the hole down to the months that actually differ, so a repair
      // moves a few hundred rows rather than the whole window again.
      const [localMonths, remote] = await Promise.all([
        input.extractor.monthlyTally(input.pcucode, input.from, input.to),
        withRetry(
          () => this.client.audit({ pcucode: input.pcucode, from: input.from, to: input.to }),
          { label: "post-sync audit detail" },
        ),
      ]);
      const centralByMonth = new Map(remote.months.map((row) => [row.month, row.rows]));

      for (const month of localMonths) {
        if ((centralByMonth.get(month.month) ?? 0) === month.rows) continue;

        const start = `${month.month}-01`;
        const endDate = new Date(`${month.month}-01T00:00:00Z`);
        endDate.setUTCMonth(endDate.getUTCMonth() + 1);
        endDate.setUTCDate(0);
        const end = endDate.toISOString().slice(0, 10);

        log.warn("gap found after sync, repairing month", {
          month: month.month,
          jhcis: month.rows,
          central: centralByMonth.get(month.month) ?? 0,
        });
        writeStatus({ message: `พบข้อมูลขาด กำลังซิงก์ซ้ำเดือน ${month.month}` });

        // reconcile:false - this repair must not start another reconcile loop.
        const repair = await this.run({
          mode: "MANUAL_RANGE",
          from: start,
          to: end,
          reconcile: false,
        });
        repairedMonths.push(month.month);
        repairedRows += repair.recordsSent;
      }

      central = await countCentral();
    }

    const gap = Math.max(0, input.expected - central - input.rejected);
    return {
      expected: input.expected,
      central,
      rejected: input.rejected,
      gap,
      repairedRows,
      repairedMonths,
    };
  }

  /**
   * Compares JHCIS with the central database month by month and re-sends only
   * the months that differ.
   *
   * Every individual batch can report success and the data still end up
   * incomplete - an upload interrupted halfway, a PC restarted mid-run, a
   * migration applied late. Counting both sides is the only honest way to know,
   * and re-sending is safe because every row is keyed deterministically.
   */
  /**
   * Narrows a range to the months Central does not already match.
   *
   * Returns null when every month agrees, which means there is nothing to
   * read at all. Comparison is by row count per month: JHCIS is
   * append-mostly, so a month whose count matches is a month nobody has
   * touched. An edit that leaves the count unchanged would not be noticed
   * here - "ตรวจสอบความครบถ้วน" exists for that, and a range asked for
   * explicitly is read whatever the counts say.
   *
   * A failure to reach Central is not a reason to skip: it falls back to
   * reading the whole range, which is what would have happened anyway.
   */
  private async narrowToMissing(
    extractor: UsageExtractor,
    pcucode: string,
    range: { from: string; to: string },
  ): Promise<{ from: string; to: string } | null> {
    let local: Array<{ month: string; rows: number }>;
    let remote: Array<{ month: string; rows: number }>;
    try {
      [local, remote] = await Promise.all([
        extractor.monthlyTally(pcucode, range.from, range.to),
        withRetry(() => this.client.audit({ pcucode, from: range.from, to: range.to }), {
          label: "audit",
        }).then((response) => response.months),
      ]);
    } catch (error) {
      log.warn("เทียบจำนวนกับศูนย์กลางไม่สำเร็จ จะดึงทั้งช่วงตามปกติ", {
        error: error instanceof Error ? error.message : String(error),
      });
      return range;
    }

    const centralByMonth = new Map(remote.map((row) => [row.month, row.rows]));
    const differing = local
      .filter((row) => (centralByMonth.get(row.month) ?? 0) !== row.rows)
      .map((row) => row.month)
      .sort();

    if (!differing.length) return null;

    // Span the differing months, clamped to what was asked for: a month is
    // read whole because that is the resolution the counts are compared at.
    const first = `${differing[0]}-01`;
    const lastMonth = new Date(`${differing[differing.length - 1]}-01T00:00:00Z`);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() + 1);
    lastMonth.setUTCDate(0);
    const last = lastMonth.toISOString().slice(0, 10);

    const from = first > range.from ? first : range.from;
    const to = last < range.to ? last : range.to;
    log.info("ดึงเฉพาะเดือนที่ยังไม่ตรงกัน", { months: differing, from, to });
    return { from, to };
  }

  async verify(options: { from?: string | null; to?: string | null; repair?: boolean } = {}): Promise<{
    checked: number;
    mismatched: Array<{ month: string; jhcis: number; central: number }>;
    /** months still different after a repair attempt (rows JHCIS holds but central rejects) */
    unresolved: Array<{ month: string; jhcis: number; central: number }>;
    repaired: number;
  }> {
    const db = new JhcisConnection();
    try {
      const { report, mapping } = await new SchemaInspector(db).inspect();
      if (!mapping || !report.pcucode) throw new Error("อ่านโครงสร้าง JHCIS ไม่สำเร็จ");
      const pcucode = report.pcucode;
      if (pcucode !== this.credential.expectedPcucode) {
        throw new Error(
          `pcucode ของ JHCISDB (${pcucode}) ไม่ตรงกับสถานบริการที่ลงทะเบียนไว้`,
        );
      }

      const extractor = new UsageExtractor(db, mapping);
      const [min, max] = await Promise.all([
        extractor.minUsageDate(pcucode),
        extractor.maxUsageDate(pcucode),
      ]);
      const from = options.from ?? min ?? today();
      const to = options.to ?? max ?? today();

      writeStatus({
        phase: "starting",
        syncPhase: "VERIFYING",
        message: `กำลังตรวจสอบความครบถ้วน ${from} ถึง ${to}`,
        rangeFrom: from,
        rangeTo: to,
        lastProgressAt: new Date().toISOString(),
      });

      const [local, remote] = await Promise.all([
        extractor.monthlyTally(pcucode, from, to),
        withRetry(() => this.client.audit({ pcucode, from, to }), { label: "audit" }),
      ]);

      const centralByMonth = new Map(remote.months.map((row) => [row.month, row.rows]));
      const mismatched = local
        .map((row) => ({
          month: row.month,
          jhcis: row.rows,
          central: centralByMonth.get(row.month) ?? 0,
        }))
        .filter((row) => row.jhcis !== row.central);

      log.info("verify finished", {
        from,
        to,
        months: local.length,
        mismatched: mismatched.length,
      });

      let repaired = 0;
      const unresolved: Array<{ month: string; jhcis: number; central: number }> = [];

      if (options.repair !== false && mismatched.length) {
        await db.close();
        for (const gap of mismatched) {
          const start = `${gap.month}-01`;
          const endDate = new Date(`${gap.month}-01T00:00:00Z`);
          endDate.setUTCMonth(endDate.getUTCMonth() + 1);
          endDate.setUTCDate(0);
          const end = endDate.toISOString().slice(0, 10);
          log.info("repairing month", { month: gap.month, jhcis: gap.jhcis, central: gap.central });
          const result = await this.run({ mode: "MANUAL_RANGE", from: start, to: end });
          repaired += result.recordsSent;
        }

        // Re-check once. A month that still differs cannot be fixed by sending
        // it again - JHCIS holds rows the central server refuses (an empty
        // drugcode, for example) - so it is reported instead of retried
        // forever on every future run.
        const after = await withRetry(() => this.client.audit({ pcucode, from, to }), {
          label: "audit re-check",
        });
        const afterByMonth = new Map(after.months.map((row) => [row.month, row.rows]));
        for (const gap of mismatched) {
          const central = afterByMonth.get(gap.month) ?? 0;
          if (central !== gap.jhcis) {
            unresolved.push({ month: gap.month, jhcis: gap.jhcis, central });
          }
        }
        if (unresolved.length) {
          log.warn("months that could not be reconciled", { unresolved });
        }
      }

      writeStatus({
        phase: mismatched.length ? "done" : "done",
        message: mismatched.length
          ? `ซ่อมข้อมูล ${mismatched.length} เดือน (${repaired.toLocaleString("th-TH")} รายการ)`
          : "ข้อมูลครบถ้วนตรงกับ JHCIS",
      });

      return { checked: local.length, mismatched, unresolved, repaired };
    } finally {
      await db.close().catch(() => undefined);
    }
  }

  /**
   * Heartbeat with the current schema report; never carries credentials.
   * Returns the central-approved config so the caller can react to a manual
   * "Sync Now" request (the server cannot call into this LAN).
   */
  async heartbeat(
    status: "ONLINE" | "SYNCING" | "ERROR",
    lastError?: string,
  ): Promise<AgentConfigResponse> {
    const db = new JhcisConnection();
    let jhcisConnected = false;
    let report = null;

    try {
      await db.ping();
      jhcisConnected = true;
      report = (await new SchemaInspector(db).inspect()).report;
    } catch (error) {
      log.warn("JHCIS not reachable during heartbeat", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await db.close();
    }

    // Recorded whether or not JHCIS answered, so a screen can tell "checked a
    // moment ago and it is down" from "never checked".
    writeStatus({
      jhcisState: jhcisConnected ? "CONNECTED" : "UNREACHABLE",
      jhcisConnected,
      jhcisCheckedAt: new Date().toISOString(),
    });

    const queue = new OfflineQueue(dataDir());
    writeStatus({ centralAttemptAt: new Date().toISOString() });

    let response;
    try {
      response = await this.client.heartbeat({
      agentVersion: AGENT_VERSION,
      // The machine's own name. This used to send installationId, so every
      // screen showed a generated id where an operator expected to see which
      // PC this is; installationId still travels in its own field and stays
      // the stable identity Central knows the installation by.
      hostname: machineHostname(),
      installationId: this.credential.installationId,
      status,
      jhcisConnected,
      pcucode: report?.pcucode ?? this.credential.expectedPcucode,
      mysqlVersion: report?.mysqlVersion ?? null,
      jhcisVersion: report?.jhcisVersion ?? null,
      schemaReport: report,
      lastError: lastError ?? null,
      pendingBatches: queue.count("PENDING"),
      network: await resolveNetworkIdentity(this.credential.centralApiUrl),
      });
    } catch (error) {
      // The attempt stands; the acknowledgement does not. Nothing after this
      // will describe the link as connected.
      writeStatus(this.centralFailure(error));
      throw error;
    }

    log.debug("heartbeat acknowledged", { config: response.config });
    writeStatus({ ...this.centralAck(), pendingChunks: queue.count("PENDING") });
    this.adoptCentralWatermark(response.config.lastSyncedVisitDate);
    return response.config;
  }

  /**
   * Trusts the central watermark whenever it is behind this agent's own.
   *
   * The agent decides where an incremental run starts from its local state, so
   * data removed at the centre - an administrator clearing a range for a
   * สถานบริการ - would never be collected again: the agent still believes it
   * delivered that window, and nothing would ever contradict it.
   *
   * Central knows what it actually holds, so when it reports an older
   * watermark than the local one, the local one is wrong and is pulled back to
   * match. Only ever backwards: a central value that is ahead means another
   * machine delivered rows this agent has not read, which is not this agent's
   * cue to skip them.
   */
  private adoptCentralWatermark(central: string | null): void {
    const state = loadState();
    const local = state.lastSyncedVisitDate;
    if (local === central) return;
    if (central !== null && (local === null || central >= local)) return;

    log.info("ปรับ watermark ตามศูนย์กลาง (ข้อมูลปลายทางถูกล้างบางส่วน)", {
      local,
      central,
    });
    saveState({ ...state, lastSyncedVisitDate: central });
  }
}

export type { SchemaMapping };
