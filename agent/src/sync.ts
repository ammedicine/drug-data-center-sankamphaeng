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
  requireCredential,
  saveState,
  type AgentCredentialFile,
} from "./config";
import { CentralApiError, CentralClient, withRetry } from "./central/client";
import { JhcisConnection } from "./jhcis/connection";
import { UsageExtractor } from "./jhcis/extractor";
import { SchemaInspector, type SchemaMapping } from "./jhcis/schema-inspector";
import { log } from "./logger";
import { OfflineQueue } from "./queue/queue";

export type SyncMode = "INITIAL" | "INCREMENTAL" | "MANUAL_RANGE" | "RETRY";

const EXTRACT_PAGE_SIZE = 500;
/** Kept in step with the server's UPLOAD_CHUNK_SIZE. */
const DEFAULT_CHUNK_SIZE = 500;

export interface SyncOptions {
  mode: SyncMode;
  from?: string | null;
  to?: string | null;
  /** extract and queue, but do not upload (used by `doctor --dry-run`) */
  dryRun?: boolean;
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
        if (!permanent) break; // network is down - stop and retry on the next run
      }
    }

    return { accepted, rejected, remaining: this.queue.count("PENDING") };
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
      const range = resolveRange(options.mode, this.credential, { min, max }, options);
      const sourceVersion = report.jhcisVersion ?? report.mysqlVersion;

      const recordsRead = await extractor.countUsage(pcucode, range.from, range.to);
      const batchRef = nextBatchRef();

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
        };
      }

      // 2. Drug master. A failure here must NOT abort the run: the usage rows
      // are already durable in the queue, and the master is re-sent every sync.
      const master = await extractor.fetchDrugMaster();
      if (master.length) {
        try {
          await withRetry(
            () =>
              this.client.upload({
                batchRef,
                pcucode,
                sourceVersion,
                drugs: master,
                records: [],
              }),
            { label: "upload drug master" },
          );
        } catch (error) {
          log.warn("drug master upload failed - continuing with usage records", {
            batchRef,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // 3. Upload every queued chunk (including leftovers from earlier runs).
      const flushed = await this.flushQueue();

      const complete = flushed.remaining === 0;
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
              : `ยังมี ${flushed.remaining} chunk ที่อัปโหลดไม่สำเร็จ`,
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

      log.info("sync finished", {
        batchRef,
        recordsRead,
        recordsSent,
        accepted: flushed.accepted,
        rejected: flushed.rejected,
        pending: flushed.remaining,
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
      };
    } finally {
      await db.close();
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

    const queue = new OfflineQueue(dataDir());
    const response = await this.client.heartbeat({
      agentVersion: AGENT_VERSION,
      hostname: this.credential.installationId,
      installationId: this.credential.installationId,
      status,
      jhcisConnected,
      pcucode: report?.pcucode ?? this.credential.expectedPcucode,
      mysqlVersion: report?.mysqlVersion ?? null,
      jhcisVersion: report?.jhcisVersion ?? null,
      schemaReport: report,
      lastError: lastError ?? null,
      pendingBatches: queue.count("PENDING"),
    });

    log.debug("heartbeat acknowledged", { config: response.config });
    return response.config;
  }
}

export type { SchemaMapping };
