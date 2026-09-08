#!/usr/bin/env node
/**
 * sdc-agent CLI.
 *
 *   sdc-agent doctor                 ตรวจการเชื่อมต่อ + schema JHCIS (ไม่ต้อง enroll)
 *   sdc-agent enroll --token <TOKEN> ลงทะเบียน Agent กับ Central
 *   sdc-agent sync [--mode ...]      ซิงก์หนึ่งรอบ
 *   sdc-agent retry                  ส่งข้อมูลที่ค้างในคิวใหม่
 *   sdc-agent run                    ทำงานต่อเนื่อง (heartbeat + ซิงก์ตามรอบ)
 *   sdc-agent status                 สรุปสถานะในเครื่อง
 */
import {
  AGENT_VERSION,
  centralApiUrl,
  dataDir,
  installationId,
  jhcisConfig,
  loadCredential,
  loadJhcisOverride,
  loadSettings,
  loadState,
  machineHostname,
  saveCredential,
  saveJhcisOverride,
  saveSettings,
  writeStatus,
} from "./config";
import { CentralClient } from "./central/client";
import { JhcisConnection } from "./jhcis/connection";
import { UsageExtractor } from "./jhcis/extractor";
import { SchemaInspector } from "./jhcis/schema-inspector";
import { log } from "./logger";
import { SyncLockedError, withSyncLock } from "./lock";
import {
  dailyOffsetSeconds,
  intervalOffsetSeconds,
  nextScheduledRun,
} from "./schedule";
import { OfflineQueue } from "./queue/queue";
import { SyncRunner, type SyncMode } from "./sync";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "true";
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const mark = (ok: boolean) => (ok ? "FOUND" : "NOT FOUND");

/** JHCIS connectivity + schema report (JHCIS_INTEGRATION section 8). */
async function doctor(): Promise<void> {
  const db = new JhcisConnection();
  try {
    console.log("## JHCIS Connection\n");
    console.log(`Target: ${db.describe()}`);
    await db.ping();
    console.log("Status: CONNECTED\n");

    const inspector = new SchemaInspector(db);
    const { report, mapping } = await inspector.inspect();

    console.log("## Database");
    console.log(`MySQL version: ${report.mysqlVersion}`);
    console.log(`JHCIS version: ${report.jhcisVersion ?? "ตรวจไม่พบ (ไม่มีตารางเวอร์ชัน)"}`);
    console.log(`pcucode: ${report.pcucode ?? "ตรวจไม่พบ"}`);
    console.log(`สถานบริการ: ${report.facilityName ?? "-"}\n`);

    console.log("## Schema");
    for (const [table, found] of Object.entries(report.tables)) {
      console.log(`${table}: ${mark(found)}`);
    }
    console.log("\n## cdrug");
    for (const [column, found] of Object.entries(report.columns.cdrug ?? {})) {
      console.log(`${column}: ${mark(found)}`);
    }
    console.log("\n## visitdrug");
    for (const [column, found] of Object.entries(report.columns.visitdrug ?? {})) {
      console.log(`${column}: ${mark(found)}`);
    }

    console.log("\n## Mapping ที่ใช้จริง");
    console.log(`จำนวนจ่าย  -> ${report.mapping.quantityColumn ?? "ไม่พบ"}`);
    console.log(`หน่วยนับ   -> ${report.mapping.unitColumn ?? "ไม่พบ"}`);
    console.log(`วันที่จ่าย -> ${report.mapping.dateColumn}`);

    console.log("\n## Capabilities");
    for (const [name, value] of Object.entries(report.capabilities)) {
      console.log(`${name}: ${value ? "yes" : "no"}`);
    }

    if (report.dataQuality) {
      const { visitDrugRows, orphanVisitDrugRows } = report.dataQuality;
      console.log("\n## ความครบถ้วนของข้อมูล visitdrug");
      console.log(`รายการจ่ายยาทั้งหมด: ${visitDrugRows.toLocaleString("th-TH")}`);
      console.log(
        `ไม่มี visit คู่กันแล้ว: ${orphanVisitDrugRows.toLocaleString("th-TH")}` +
          " (ยังถูกดึงและส่งขึ้นศูนย์กลาง โดยใช้วันที่จาก dateupdate)",
      );
      console.log(
        `ดึงได้ทั้งหมด: ${visitDrugRows.toLocaleString("th-TH")} / ${visitDrugRows.toLocaleString("th-TH")} รายการ`,
      );
    }

    if (report.warnings.length) {
      console.log("\n## คำเตือน");
      for (const warning of report.warnings) console.log(`- ${warning}`);
    }

    if (mapping && report.pcucode) {
      const extractor = new UsageExtractor(db, mapping);
      const [min, max] = await Promise.all([
        extractor.minUsageDate(report.pcucode),
        extractor.maxUsageDate(report.pcucode),
      ]);
      console.log(`\n## ข้อมูลที่มี\nช่วงวันที่: ${min ?? "-"} ถึง ${max ?? "-"}`);

      if (max) {
        const from = new Date(new Date(`${max}T00:00:00Z`).getTime() - 6 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const count = await extractor.countUsage(report.pcucode, from, max);
        console.log(`รายการจ่ายยา ${from} ถึง ${max}: ${count.toLocaleString("th-TH")} รายการ`);

        // Sample rows contain no patient identity (JHCIS_INTEGRATION section 26).
        console.log("\n## ตัวอย่างข้อมูล (5 แถวแรก)");
        for await (const page of extractor.streamUsage(report.pcucode, from, max, 5)) {
          for (const row of page.slice(0, 5)) {
            console.log(
              `${row.usageDate}  visitno=${row.visitNo}  ${row.drugCode}  ` +
                `${(row.drugName ?? "").slice(0, 28).padEnd(28)}  qty=${row.quantity} ${row.unit ?? ""}`,
            );
          }
          break;
        }
      }
    }

    const credential = loadCredential();
    console.log("\n## Agent");
    console.log(`version: ${AGENT_VERSION}`);
    console.log(`enrolled: ${credential ? `yes (${credential.facilityCode})` : "no"}`);
    if (credential && report.pcucode && credential.expectedPcucode !== report.pcucode) {
      console.log(
        `!! pcucode ไม่ตรงกัน: JHCISDB=${report.pcucode} แต่ลงทะเบียนไว้เป็น ${credential.expectedPcucode}`,
      );
    }
    console.log(`คิวค้างส่ง: ${new OfflineQueue(dataDir()).count("PENDING")} chunk`);
  } finally {
    await db.close();
  }
}

async function enroll(): Promise<void> {
  const token = arg("token");
  if (!token || token === "true") throw new Error("ต้องระบุ --token <ENROLLMENT_TOKEN>");
  const url = arg("url") ?? centralApiUrl();

  const db = new JhcisConnection();
  let pcucode: string | null = null;
  try {
    pcucode = await new SchemaInspector(db).detectPcucode();
  } catch (error) {
    log.warn("อ่าน pcucode จาก JHCISDB ไม่ได้ ระบบจะให้ Central ตรวจสอบแทน", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await db.close();
  }

  const client = new CentralClient(url);
  const result = await client.enroll({
    token,
    hostname: machineHostname(),
    installationId: installationId(),
    pcucode,
  });

  saveCredential({
    agentId: result.agentId,
    keyId: result.keyId,
    secret: result.secret,
    centralApiUrl: url,
    facilityId: result.facility.id,
    facilityCode: result.facility.code,
    facilityName: result.facility.name,
    expectedPcucode: result.facility.pcucode,
    installationId: installationId(),
    syncIntervalMinutes: result.syncIntervalMinutes,
    reprocessDays: result.reprocessDays,
    enrolledAt: new Date().toISOString(),
  });

  console.log(`ลงทะเบียนสำเร็จกับ ${result.facility.code} · ${result.facility.name}`);
  console.log(`pcucode ที่ผูกไว้: ${result.facility.pcucode}`);
  console.log("credential ถูกบันทึกไว้ที่ agent.config.json (อย่าแชร์ไฟล์นี้)");
}

async function sync(): Promise<void> {
  const mode = (arg("mode") ?? "INCREMENTAL").toUpperCase() as SyncMode;
  const runner = new SyncRunner();
  try {
    await runner.heartbeat("SYNCING");
    const result = await withSyncLock("sync (manual)", () =>
      runner.run({
        mode,
      from: arg("from") ?? null,
      to: arg("to") ?? null,
      dryRun: has("dry-run"),
      }),
    );
    console.log(
      `${result.batchRef}: อ่าน ${result.recordsRead} · ส่ง ${result.recordsSent} · ` +
        `บันทึก ${result.accepted} · ปฏิเสธ ${result.rejected} · ค้าง ${result.pendingChunks} chunk`,
    );

    const check = result.reconciliation;
    if (check) {
      console.log(
        `ตรวจสอบหลังซิงก์: JHCIS ${check.expected} · ศูนย์กลาง ${check.central} · ` +
          `ปฏิเสธ ${check.rejected} · ขาด ${check.gap}`,
      );
      if (check.repairedMonths.length) {
        console.log(
          `  ซิงก์ซ้ำอัตโนมัติ ${check.repairedMonths.length} เดือน (${check.repairedMonths.join(", ")})`,
        );
      }
      console.log(check.gap === 0 ? "  ข้อมูลครบถ้วน" : "  ยังขาดข้อมูล ระบบจะพยายามใหม่รอบถัดไป");
    }
    await runner.heartbeat(result.pendingChunks ? "ERROR" : "ONLINE");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A run that ended in an error must not leave SUCCESS on screen from the
    // run before it - including when it failed before it started, which is
    // what a heartbeat failure is.
    writeStatus({ phase: "error", syncPhase: "ERROR", lastError: message });
    await new SyncRunner().heartbeat("ERROR", message).catch(() => undefined);
    throw error;
  }
}

/** Compares JHCIS with the central database and re-sends whatever is missing. */
async function verify(): Promise<void> {
  const runner = new SyncRunner();
  const result = await withSyncLock("verify (manual)", () =>
    runner.verify({
      from: arg("from") ?? null,
    to: arg("to") ?? null,
    repair: !has("check-only"),
    }),
  );

  console.log(`ตรวจสอบ ${result.checked} เดือน`);
  if (!result.mismatched.length) {
    console.log("ข้อมูลครบถ้วน ตรงกับ JHCIS ทุกเดือน");
    return;
  }
  console.log(`พบเดือนที่ข้อมูลไม่ตรงกัน ${result.mismatched.length} เดือน:`);
  for (const row of result.mismatched.slice(0, 24)) {
    console.log(`  ${row.month}  JHCIS ${row.jhcis}  ศูนย์กลาง ${row.central}`);
  }
  if (has("check-only")) {
    console.log("(โหมดตรวจอย่างเดียว ไม่ได้ส่งข้อมูลซ้ำ)");
    return;
  }

  console.log(`ส่งข้อมูลซ่อมแล้ว ${result.repaired} รายการ`);
  if (result.unresolved.length) {
    console.log(
      `
ยังไม่ตรงกัน ${result.unresolved.length} เดือน - เป็นแถวที่ข้อมูลต้นทางไม่ผ่านการตรวจสอบ` +
        " (ดูเหตุผลรายแถวได้ที่หน้าเว็บ หัวข้อประวัติการซิงก์)",
    );
    for (const row of result.unresolved) {
      console.log(`  ${row.month}  JHCIS ${row.jhcis}  ศูนย์กลาง ${row.central}`);
    }
  }
}

async function retry(): Promise<void> {
  const queue = new OfflineQueue(dataDir());
  const runner = new SyncRunner();

  const moved = queue.requeueFailed();
  const result = await withSyncLock("retry (manual)", () => runner.flushQueue());
  console.log(
    `นำกลับเข้าคิว ${moved} chunk · บันทึกสำเร็จ ${result.accepted} · ปฏิเสธ ${result.rejected} · ค้าง ${result.remaining}`,
  );

  // Anything that failed permanently is usually a chunk whose batch the server
  // has already closed; move it to a fresh batch rather than leaving it parked.
  const recovery = await runner.recoverOrphanChunks();
  if (recovery.recovered) {
    console.log(`กู้ข้อมูลที่ค้าง ${recovery.recovered} รายการ ผ่านรอบใหม่ ${recovery.batchRef}`);
  }
}

/**
 * Long-running mode: heartbeat, scheduled sync, and "Sync Now" requests that
 * arrive on the heartbeat response. The desktop app runs this as a child
 * process; it can also be run headless as a Windows service.
 *
 * Scheduling comes from data/settings.json (owned by the operator through the
 * desktop app) and falls back to the interval the central server approved.
 */
async function run(): Promise<void> {
  const runner = new SyncRunner();
  const credential = loadCredential();
  if (!credential) throw new Error("ยังไม่ได้ลงทะเบียน Agent (sdc-agent enroll)");

  // Every agent gets its own slot within the schedule, derived from this id,
  // so a district that all syncs "every hour" does not arrive at once.
  const agentId = credential.agentId;

  let stopping = false;
  let running = false;
  /** clock times already fired today, so a daily time runs once per day */
  const firedToday = new Set<string>();
  let lastIntervalRun = 0;

  const shutdown = () => {
    stopping = true;
    log.info("agent stopping");
    writeStatus({ phase: "idle", message: "หยุดทำงานแล้ว" });
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const safeHeartbeat = async (state: "ONLINE" | "SYNCING" | "ERROR", error?: string) => {
    try {
      const config = await runner.heartbeat(state, error);
      writeStatus({ centralConnected: true });
      return config;
    } catch (heartbeatError) {
      const message =
        heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError);
      log.warn("heartbeat failed", { error: message });
      writeStatus({ centralConnected: false, lastError: message });
      return null;
    }
  };

  const runOnce = async (reason: string, window?: { from: string; to: string }) => {
    if (stopping || running) return;
    running = true;
    try {
      log.info("sync triggered", { reason, ...(window ?? {}) });
      await safeHeartbeat("SYNCING");
      // A window asked for from the web is read exactly as given, even where
      // the agent believes it already delivered those days - that is the whole
      // point of asking for it.
      // The in-process `running` flag guards this worker against itself; the
      // lock guards it against the tray, which starts sync in its own process.
      const result = await withSyncLock(`sync (${reason})`, () =>
        runner.run(
          window
            ? { mode: "MANUAL_RANGE", from: window.from, to: window.to }
            : { mode: "INCREMENTAL" },
        ),
      );
      await safeHeartbeat(result.pendingChunks ? "ERROR" : "ONLINE");
    } catch (error) {
      if (error instanceof SyncLockedError) {
        // The tray started a sync by hand while the schedule came due. Skip
        // this tick rather than reporting a failure: nothing is wrong, and the
        // next tick will find the pipeline free.
        log.info("skipping this tick, a sync is already running", {
          holder: error.holder.label,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error("scheduled sync failed", { error: message });
      // A failed run must not stop the agent: the queue keeps whatever was read
      // and the next tick (or a manual retry) picks up from there.
      writeStatus({
        phase: "error",
        syncPhase: "ERROR",
        lastError: message,
        message: "ซิงก์ไม่สำเร็จ",
      });
      await safeHeartbeat("ERROR", message);
    } finally {
      running = false;
    }
  };

  const settings = loadSettings();
  log.info("agent started", {
    facility: credential.facilityCode,
    autoSyncEnabled: settings.autoSyncEnabled,
    syncIntervalMinutes: settings.syncIntervalMinutes,
    dailyTimes: settings.dailyTimes,
  });
  writeStatus({ phase: "idle", message: "พร้อมทำงาน", lastError: null });

  await safeHeartbeat("ONLINE");

  // One ticker drives everything so settings changes take effect without a
  // restart: the file is re-read on every tick.
  const TICK_MS = 30_000;
  let lastHeartbeat = Date.now();

  setInterval(() => {
    void (async () => {
      if (stopping) return;
      const current = loadSettings();
      const now = new Date();

      // Seconds, not minutes: this is how quickly the web learns that an
      // agent is alive, that JHCIS came back, or that a sync finished. A
      // settings.json from an older Agent has no heartbeatSeconds, so its
      // minutes are converted rather than ignored.
      const heartbeatEvery = Math.max(
        10,
        current.heartbeatSeconds ?? (current.heartbeatMinutes ?? 1) * 60,
      );
      const heartbeatDue = Date.now() - lastHeartbeat >= heartbeatEvery * 1000;
      if (heartbeatDue) {
        lastHeartbeat = Date.now();
        const config = await safeHeartbeat(running ? "SYNCING" : "ONLINE");
        // "Sync Now" pressed in the web app: central cannot reach into this
        // LAN, so the request rides back on the heartbeat response.
        // "ตรวจสอบความครบถ้วน" is a heavier request than a plain sync: it
        // reconciles every month with JHCIS and re-sends only what is missing.
        if (config?.verifyRequested) {
          running = true;
          try {
            log.info("verify requested by an operator");
            await withSyncLock("verify (central request)", () => runner.verify({}));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error("verify failed", { error: message });
            writeStatus({ phase: "error", syncPhase: "ERROR", lastError: message });
          } finally {
            running = false;
          }
          return;
        }
        if (config?.syncRequested) {
          const from = config.syncRequestedFrom;
          const to = config.syncRequestedTo;
          await runOnce("central request", from && to ? { from, to } : undefined);
          return;
        }
      }

      if (!current.autoSyncEnabled) {
        // Nothing is scheduled, so the published time must say so. Leaving the
        // last one in place would have the screen counting down to a run that
        // is never going to happen.
        writeStatus({ nextSyncAt: null });
        return;
      }

      const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const dayKey = now.toISOString().slice(0, 10);
      for (const time of current.dailyTimes) {
        const marker = `${dayKey} ${time}`;
        if (time !== clock || firedToday.has(marker)) continue;
        // The operator's time is kept; the offset only moves the run within
        // that minute, so twenty clinics set to 08:00 do not all arrive in the
        // same second.
        const offset = dailyOffsetSeconds(agentId, time);
        if (now.getSeconds() < offset) continue;
        firedToday.add(marker);
        await runOnce(`daily ${time}`);
        return;
      }

      if (current.syncIntervalMinutes > 0) {
        const offset = intervalOffsetSeconds(agentId, current.syncIntervalMinutes) * 1000;
        const dueAt = lastIntervalRun + current.syncIntervalMinutes * 60_000 + offset;
        if (Date.now() >= dueAt) {
          lastIntervalRun = Date.now();
          await runOnce(`every ${current.syncIntervalMinutes} minutes`);
        }
      }

      // Publish the real moment, offset included, so the screen shows when the
      // sync will happen rather than when the schedule nominally fires.
      const next = nextScheduledRun({
        agentId,
        now,
        intervalMinutes: current.autoSyncEnabled ? current.syncIntervalMinutes : 0,
        dailyTimes: current.autoSyncEnabled ? current.dailyTimes : [],
        lastIntervalRunAt: lastIntervalRun,
      });
      writeStatus({ nextSyncAt: next ? next.toISOString() : null });
    })();
  }, TICK_MS);

  lastIntervalRun = Date.now();

  // The catch-up run starts only once the ticker above exists, and is not
  // awaited. Awaiting it here meant no heartbeat could be sent until it
  // finished - and the first run after enrolment reads the whole history, so
  // the web called a machine offline for twenty minutes while its data was
  // arriving. The `running` guard inside runOnce still keeps this from
  // overlapping with a scheduled run.
  if (settings.autoSyncEnabled && settings.syncIntervalMinutes > 0) {
    void runOnce("startup");
  }
}

function status(): void {
  const credential = loadCredential();
  const state = loadState();
  const queue = new OfflineQueue(dataDir());

  console.log(`agent version : ${AGENT_VERSION}`);
  console.log(`hostname      : ${machineHostname()}`);
  console.log(`enrolled      : ${credential ? `${credential.facilityCode} · ${credential.facilityName}` : "ยังไม่ได้ลงทะเบียน"}`);
  console.log(`pcucode       : ${credential?.expectedPcucode ?? "-"}`);
  console.log(`central       : ${credential?.centralApiUrl ?? "-"}`);
  console.log(`ข้อมูลถึงวันที่ : ${state.lastSyncedVisitDate ?? "-"}`);
  console.log(`ซิงก์ล่าสุด    : ${state.lastSyncAt ?? "-"}`);
  console.log(`คิวค้างส่ง     : ${queue.count("PENDING")} chunk (ล้มเหลว ${queue.count("FAILED")})`);
}

/** Prints or updates data/settings.json; used by the desktop app. */
function settings(): void {
  const patch: Record<string, unknown> = {};
  const interval = arg("interval");
  const times = arg("times");
  const auto = arg("auto");

  if (interval && interval !== "true") patch.syncIntervalMinutes = Number(interval);
  if (times && times !== "true") {
    patch.dailyTimes = times
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^\d{2}:\d{2}$/.test(item));
  }
  if (auto) patch.autoSyncEnabled = auto !== "false";

  const result = Object.keys(patch).length ? saveSettings(patch) : loadSettings();
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Reads or replaces the JHCIS connection.
 *
 * `jhcis` on its own prints the settings in use, with the password masked, so
 * the desktop app can show them. `jhcis --set` reads the new settings as JSON
 * on stdin rather than from the command line, because arguments are visible to
 * every process on the machine and one of these fields is a password.
 */
async function jhcis(): Promise<void> {
  if (!process.argv.includes("--set")) {
    const current = jhcisConfig();
    const overridden = loadJhcisOverride() !== null;
    console.log(
      JSON.stringify(
        {
          host: current.host,
          port: current.port,
          database: current.database,
          user: current.user,
          hasPassword: Boolean(current.password),
          // false = ยังใช้ค่าจาก .env อยู่ (ยังไม่เคยตั้งจากหน้าจอ)
          fromOverride: overridden,
        },
        null,
        2,
      ),
    );
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("ไม่ได้รับค่าการเชื่อมต่อทาง stdin");

  const input = JSON.parse(raw) as Partial<Record<string, unknown>>;
  const host = String(input.host ?? "").trim();
  const user = String(input.user ?? "").trim();
  const port = Number(input.port ?? 3306);
  if (!host) throw new Error("ต้องระบุ host หรือ IP ของ JHCISDB");
  if (!user) throw new Error("ต้องระบุชื่อผู้ใช้ฐานข้อมูล");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`port ไม่ถูกต้อง: ${String(input.port)}`);
  }

  // No password in the payload means "keep the one already stored", so moving
  // the server to a new IP does not require retyping it.
  const existing = loadJhcisOverride();
  const password =
    typeof input.password === "string"
      ? input.password
      : (existing?.password ?? process.env.JHCIS_DB_PASSWORD ?? "");

  saveJhcisOverride({
    host,
    port,
    database: String(input.database ?? "jhcisdb").trim() || "jhcisdb",
    user,
    password,
  });
  console.log(`บันทึกการเชื่อมต่อแล้ว: ${user}@${host}:${port}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  switch (command) {
    case "doctor":
    case "test-jhcis":
      return doctor();
    case "enroll":
      return enroll();
    case "sync":
      return sync();
    case "retry":
      return retry();
    case "verify":
      return verify();
    case "run":
      return run();
    case "status":
      return status();
    case "settings":
      return settings();
    case "jhcis":
      return jhcis();
    default:
      console.log(
        [
          `sdc-agent ${AGENT_VERSION}`,
          "",
          "  doctor                          ตรวจการเชื่อมต่อและ schema ของ JHCISDB",
          "  enroll --token <TOKEN> [--url]  ลงทะเบียนกับ Central",
          "  sync [--mode INITIAL|INCREMENTAL|MANUAL_RANGE] [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
          "  retry                           ส่งข้อมูลที่ค้างในคิวใหม่",
          "  verify [--from] [--to] [--check-only]",
          "                                  ตรวจความครบถ้วนรายเดือนกับศูนย์กลาง แล้วซ่อมส่วนที่ขาด",
          "  run                             ทำงานต่อเนื่อง (สำหรับ Windows Service)",
          "  status                          สรุปสถานะในเครื่อง",
          "  settings [--interval N] [--times 08:00,16:00] [--auto true|false]",
          "                                  ดู/ตั้งค่าตารางการซิงก์ในเครื่อง",
          "  jhcis [--set]                   ดูการเชื่อมต่อ JHCISDB (--set = อ่านค่าใหม่เป็น JSON ทาง stdin)",
        ].join("\n"),
      );
  }
}

main().catch((error) => {
  log.error("command failed", { error: error instanceof Error ? error.message : String(error) });
  console.error(`\nผิดพลาด: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
