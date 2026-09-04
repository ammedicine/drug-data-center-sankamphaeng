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
  loadCredential,
  loadState,
  machineHostname,
  saveCredential,
} from "./config";
import { CentralClient } from "./central/client";
import { JhcisConnection } from "./jhcis/connection";
import { UsageExtractor } from "./jhcis/extractor";
import { SchemaInspector } from "./jhcis/schema-inspector";
import { log } from "./logger";
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
    const result = await runner.run({
      mode,
      from: arg("from") ?? null,
      to: arg("to") ?? null,
      dryRun: has("dry-run"),
    });
    console.log(
      `${result.batchRef}: อ่าน ${result.recordsRead} · ส่ง ${result.recordsSent} · ` +
        `บันทึก ${result.accepted} · ปฏิเสธ ${result.rejected} · ค้าง ${result.pendingChunks} chunk`,
    );
    await runner.heartbeat(result.pendingChunks ? "ERROR" : "ONLINE");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await new SyncRunner().heartbeat("ERROR", message).catch(() => undefined);
    throw error;
  }
}

async function retry(): Promise<void> {
  const queue = new OfflineQueue(dataDir());
  const moved = queue.requeueFailed();
  const result = await new SyncRunner().flushQueue();
  console.log(
    `นำกลับเข้าคิว ${moved} chunk · บันทึกสำเร็จ ${result.accepted} · ปฏิเสธ ${result.rejected} · ค้าง ${result.remaining}`,
  );
}

/** Long-running mode used by the Windows service wrapper. */
async function run(): Promise<void> {
  const runner = new SyncRunner();
  const credential = loadCredential();
  if (!credential) throw new Error("ยังไม่ได้ลงทะเบียน Agent (sdc-agent enroll)");

  const heartbeatMs = 5 * 60_000;
  const syncMs = Math.max(15, credential.syncIntervalMinutes) * 60_000;
  let stopping = false;

  const shutdown = () => {
    stopping = true;
    log.info("agent stopping");
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("agent started", {
    facility: credential.facilityCode,
    syncIntervalMinutes: credential.syncIntervalMinutes,
  });

  const safeHeartbeat = async (status: "ONLINE" | "SYNCING" | "ERROR", error?: string) => {
    try {
      return await runner.heartbeat(status, error);
    } catch (heartbeatError) {
      log.warn("heartbeat failed", {
        error: heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError),
      });
      return null;
    }
  };

  await safeHeartbeat("ONLINE");

  // A "Sync Now" pressed in the web app arrives as a flag on the heartbeat
  // response - the central server has no way to call into this LAN.
  setInterval(() => {
    void safeHeartbeat("ONLINE").then((config) => {
      if (config?.syncRequested) {
        log.info("manual sync requested by an operator");
        void runOnce();
      }
    });
  }, heartbeatMs);

  const runOnce = async () => {
    if (stopping) return;
    try {
      await safeHeartbeat("SYNCING");
      const result = await runner.run({ mode: "INCREMENTAL" });
      await safeHeartbeat(result.pendingChunks ? "ERROR" : "ONLINE");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("scheduled sync failed", { error: message });
      await safeHeartbeat("ERROR", message);
    }
  };

  await runOnce();
  setInterval(() => void runOnce(), syncMs);
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
    case "run":
      return run();
    case "status":
      return status();
    default:
      console.log(
        [
          `sdc-agent ${AGENT_VERSION}`,
          "",
          "  doctor                          ตรวจการเชื่อมต่อและ schema ของ JHCISDB",
          "  enroll --token <TOKEN> [--url]  ลงทะเบียนกับ Central",
          "  sync [--mode INITIAL|INCREMENTAL|MANUAL_RANGE] [--from YYYY-MM-DD] [--to YYYY-MM-DD]",
          "  retry                           ส่งข้อมูลที่ค้างในคิวใหม่",
          "  run                             ทำงานต่อเนื่อง (สำหรับ Windows Service)",
          "  status                          สรุปสถานะในเครื่อง",
        ].join("\n"),
      );
  }
}

main().catch((error) => {
  log.error("command failed", { error: error instanceof Error ? error.message : String(error) });
  console.error(`\nผิดพลาด: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
