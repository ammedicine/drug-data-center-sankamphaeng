import { Lock, Server, Wifi, WifiOff, PauseCircle, TriangleAlert } from "lucide-react";

import { Card, PageHeader, StatCard, Section, relativeTime } from "@/components/ui/primitives";
import { requireSuperAdmin } from "@/lib/auth/rbac";
import { getLatestAgentRelease } from "@/lib/services/agent-release";
import { listFleet, resetReadiness, summariseFleet } from "@/lib/services/fleet";
import { latestUpdateCommands } from "@/lib/services/update-commands";
import { toThaiDate } from "@/lib/shared/sync-control";
import { TERMINAL_UPDATE_STATES } from "@/lib/shared/update-command";
import { isNewerVersion } from "@/lib/shared/version";

import { FleetControls, type FleetRowView } from "./fleet-controls";

export const metadata = { title: "จัดการ Agent ทั้งหมด" };
export const dynamic = "force-dynamic";

/**
 * One screen that answers whether the centre can safely be reset.
 *
 * SUPER_ADMIN only, and separate from /admin/agents rather than bolted onto
 * it: that page is readable by ADMIN, and the controls here stop a
 * สถานบริการ sending data. The server action checks the role again anyway -
 * hiding a button is not access control - but a page that ADMIN can open and
 * not use would be a worse answer than one they cannot open.
 */
export default async function FleetPage() {
  await requireSuperAdmin();

  const rows = await listFleet();
  const summary = summariseFleet(rows);
  const readiness = resetReadiness(rows);
  // The command rows are the record; the agents table holds the agent's own
  // last word. Both are shown, because they can legitimately differ for a
  // minute (the centre delivered; the agent has not heartbeated yet).
  const [commands, latestRelease] = await Promise.all([latestUpdateCommands(), getLatestAgentRelease()]);
  const latestVersion = latestRelease?.version.replace(/^v/i, "") ?? null;

  const view: FleetRowView[] = rows.map((r) => ({
    agentId: r.agentId,
    agentName: r.agentName,
    hostname: r.hostname,
    facilityCode: r.facilityCode,
    facilityName: r.facilityName,
    pcucode: r.pcucode,
    version: r.version,
    buildId: r.buildId,
    status: r.status,
    jhcis: r.jhcis,
    desiredSyncState: r.desiredSyncState,
    effectiveSyncState: r.effectiveSyncState,
    ack: r.ack,
    ingestAllowed: r.ingestAllowed,
    syncStartDate: r.syncStartDate,
    lastSeenLabel: relativeTime(r.lastSeenAt),
    pendingBatches: r.pendingBatches,
    problem: r.status === "OFFLINE" || r.jhcis === "UNREACHABLE" || Boolean(r.lastError),
    current: r.current
      ? {
          recordsRead: r.current.recordsRead,
          recordsAccepted: r.current.recordsAccepted,
          progress: r.current.progress,
        }
      : null,
    supportsRemotePause: r.capabilities.remotePause,
    supportsRemoteUpdate: r.capabilities.remoteUpdate,
    latestVersion,
    updateAvailable: latestVersion ? isNewerVersion(latestVersion, r.version) : false,
    command: (() => {
      const c = commands.get(r.agentId);
      if (!c) return null;
      return {
        id: c.id,
        status: c.status,
        targetVersion: c.targetVersion,
        requestedAtLabel: relativeTime(c.requestedAt),
        requestedByName: c.requestedByName,
        errorCode: c.lastErrorCode,
        errorMessage: c.lastErrorMessage,
        terminal: TERMINAL_UPDATE_STATES.includes(c.status),
        completedAtLabel: c.completedAt ? relativeTime(c.completedAt) : null,
      };
    })(),
    updater: {
      state: r.update.state,
      checkedAtLabel: r.update.checkedAt ? relativeTime(r.update.checkedAt) : null,
      succeededAtLabel: r.update.succeededAt ? relativeTime(r.update.succeededAt) : null,
      errorCode: r.update.errorCode,
      error: r.update.error,
      errorAtLabel: r.update.errorAt ? relativeTime(r.update.errorAt) : null,
      task: r.update.task,
    },
  }));

  const ready = readiness.filter((r) => r.safeToReset).length;

  return (
    <>
      <PageHeader
        title="จัดการ Agent ทั้งหมด"
        subtitle="สถานะการเชื่อมต่อ การซิงก์ และการอัปเดตของทุกสถานบริการ"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Agent ทั้งหมด" value={summary.total} icon={Server} />
        <StatCard label="ออนไลน์" value={summary.online} tone="ok" icon={Wifi} />
        <StatCard
          label="ออฟไลน์"
          value={summary.offline}
          tone={summary.offline ? "warn" : "default"}
          icon={WifiOff}
        />
        <StatCard
          label="หยุดการซิงก์"
          value={summary.paused}
          tone={summary.paused ? "warn" : "default"}
          icon={PauseCircle}
        />
        <StatCard label="กำลังซิงก์" value={summary.syncing} icon={Server} />
        <StatCard
          label="ศูนย์กลางบล็อกอยู่"
          value={summary.ingestBlocked}
          tone={summary.ingestBlocked ? "warn" : "default"}
          icon={Lock}
        />
        <StatCard
          label="รอ Agent รับคำสั่ง"
          value={summary.awaitingAck}
          tone={summary.awaitingAck ? "warn" : "default"}
        />
        <StatCard
          label="มีปัญหา"
          value={summary.problems}
          tone={summary.problems ? "danger" : "default"}
          icon={TriangleAlert}
        />
      </div>

      <Section title="Agent ทุกเครื่อง" description="หนึ่งแถวต่อหนึ่ง Agent - หนึ่งสถานบริการอาจมีมากกว่าหนึ่งเครื่อง">
        <FleetControls rows={view} />
      </Section>

      <Section
        title="ความพร้อมก่อนล้างข้อมูล"
        description="แยกให้ชัดระหว่างสิ่งที่ศูนย์กลางรับประกันได้เอง กับสิ่งที่ต้องรอ Agent ตอบกลับ"
      >
        <Card>
          <div className="p-4">
            <p className="mb-3 text-sm text-slate-600">
              พร้อมล้างข้อมูล {ready} จาก {readiness.length} Agent · การบล็อกที่ศูนย์กลางคือสิ่งที่ทำให้ปลอดภัย
              ส่วนการที่ Agent ตอบรับคำสั่งเป็นเรื่องน่าอุ่นใจ แต่ไม่จำเป็น - เครื่องที่ปิดอยู่หรือรุ่นเก่าจะไม่มีวันตอบ
              และก็ยังส่งข้อมูลเข้ามาไม่ได้อยู่ดี
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="p-2">สถานบริการ</th>
                    <th className="p-2">เวอร์ชัน</th>
                    <th className="p-2">ศูนย์กลางบล็อก</th>
                    <th className="p-2">Agent ตอบรับ</th>
                    <th className="p-2">เริ่มเก็บข้อมูล</th>
                    <th className="p-2">กำลังซิงก์</th>
                    <th className="p-2">พร้อม</th>
                  </tr>
                </thead>
                <tbody>
                  {readiness.map((r) => (
                    <tr key={r.agentId} className="border-t border-slate-100">
                      <td className="p-2">
                        <div>{r.facilityName}</div>
                        <div className="text-xs text-slate-500">{r.facilityCode}</div>
                      </td>
                      <td className="p-2">
                        {r.version ?? "-"}
                        {r.buildId ? (
                          <span className="text-xs text-slate-500"> ({r.buildId.slice(0, 7)})</span>
                        ) : null}
                      </td>
                      <td className="p-2">
                        {r.centralBlocked ? (
                          <span className="text-emerald-700">🔒 บล็อกแล้ว</span>
                        ) : (
                          <span className="text-slate-500">ยังรับข้อมูลอยู่</span>
                        )}
                      </td>
                      <td className="p-2">
                        {r.ack === "IN_SYNC" ? (
                          <span className="text-emerald-700">หยุดแล้ว</span>
                        ) : r.ack === "UNSUPPORTED" ? (
                          <span className="text-slate-500">รุ่นนี้ยังไม่รองรับ</span>
                        ) : r.ack === "NEVER_ACKED" ? (
                          <span className="text-slate-500">ยังไม่เคยตอบ</span>
                        ) : (
                          <span className="text-amber-700">รอ ACK</span>
                        )}
                      </td>
                      <td className="p-2">
                        {r.syncStartDate ? (
                          toThaiDate(r.syncStartDate)
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="p-2">
                        {r.activeSync ? (
                          <span className="text-amber-700">กำลังซิงก์</span>
                        ) : (
                          <span className="text-slate-500">ไม่มี</span>
                        )}
                      </td>
                      <td className="p-2">
                        {r.safeToReset ? (
                          <span className="text-emerald-700">✓ ปลอดภัยจากฝั่งศูนย์กลาง</span>
                        ) : (
                          <span className="text-amber-700">⚠ {r.blocker}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              หน้านี้ไม่มีปุ่มล้างข้อมูล การหยุดการซิงก์กับการล้างข้อมูลเป็นคนละขั้นตอนโดยตั้งใจ
            </p>
          </div>
        </Card>
      </Section>
    </>
  );
}
