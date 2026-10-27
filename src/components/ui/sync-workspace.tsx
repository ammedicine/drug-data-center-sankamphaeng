import clsx from "clsx";
import {
  Activity,
  Building2,
  CircleCheckBig,
  Clock3,
  Database,
  RefreshCcw,
  Server,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import React, { type ReactNode } from "react";

import { JHCIS_LINK_LABELS, type JhcisLinkState } from "@/lib/shared/agent-status";
import type { AgentStatus } from "@/lib/db/schema";

import { formatDate, formatDateTime, formatNumber, relativeTime } from "./primitives";

export function SyncWorkspace({
  header,
  monitoring,
  agents,
  setup,
}: {
  header: ReactNode;
  monitoring: ReactNode;
  agents: ReactNode;
  setup: ReactNode;
}) {
  return (
    <div className="space-y-3 pb-6" data-sync-workspace>
      <div data-sync-section="header">{header}</div>
      <div data-sync-section="monitoring">{monitoring}</div>
      <div data-sync-section="agents">{agents}</div>
      <div data-sync-section="setup">{setup}</div>
    </div>
  );
}

export function SyncPageHeader({ action }: { action?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="mb-1 text-xs font-medium text-slate-500">ระบบ / การซิงก์ข้อมูล</p>
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.025em] text-slate-950 sm:text-[30px]">
          สถานะการซิงก์ข้อมูล
        </h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
          Agent ภายในเครือข่ายสถานบริการอ่านข้อมูลจาก JHCIS แบบอ่านอย่างเดียว แล้วส่งเข้าสู่ศูนย์กลางอย่างปลอดภัยผ่าน HTTPS
        </p>
      </div>
      {action ? <div className="shrink-0 no-print">{action}</div> : null}
    </header>
  );
}

const KPI_STYLES = [
  { icon: Server, iconClass: "bg-blue-50 text-blue-600", valueClass: "text-slate-950" },
  { icon: RefreshCcw, iconClass: "bg-emerald-50 text-emerald-600", valueClass: "text-slate-950" },
  { icon: TriangleAlert, iconClass: "bg-amber-50 text-amber-600", valueClass: "text-slate-950" },
  { icon: Building2, iconClass: "bg-violet-50 text-violet-600", valueClass: "text-slate-950" },
] as const;

export function SyncKpiGrid({
  online,
  totalAgents,
  lastSyncLabel,
  failedBatches24h,
  facilitiesInScope,
}: {
  online: number;
  totalAgents: number;
  lastSyncLabel: string;
  failedBatches24h: number;
  facilitiesInScope: number;
}) {
  const items = [
    {
      label: "Agent ออนไลน์",
      value: `${formatNumber(online)} / ${formatNumber(totalAgents)}`,
      unit: "เครื่อง",
      hint: totalAgents ? "สถานะจาก heartbeat ล่าสุด" : "ยังไม่มี Agent ในขอบเขตนี้",
    },
    {
      label: "ซิงก์ล่าสุด",
      value: lastSyncLabel,
      unit: "",
      hint: "รอบที่บันทึกสำเร็จล่าสุด",
    },
    {
      label: "ซิงก์ล้มเหลว 24 ชม.",
      value: formatNumber(failedBatches24h),
      unit: "รอบ",
      hint: failedBatches24h ? "ควรตรวจสอบรายละเอียดด้านล่าง" : "ไม่พบรายการล้มเหลว",
    },
    {
      label: "สถานบริการในสิทธิ์",
      value: formatNumber(facilitiesInScope),
      unit: "แห่ง",
      hint: "ตามสิทธิ์ของบัญชีปัจจุบัน",
    },
  ];

  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="สรุปสถานะการซิงก์">
      {items.map((item, index) => {
        const style = KPI_STYLES[index];
        const Icon = style.icon;
        const failed = index === 2 && failedBatches24h > 0;
        return (
          <article
            key={item.label}
            data-sync-kpi={item.label}
            className={clsx(
              "rounded-[14px] border bg-white px-4 py-3 shadow-[0_7px_22px_rgba(31,78,112,0.055)]",
              failed ? "border-red-200/90" : "border-slate-200/85",
            )}
          >
            <div className="flex items-start gap-3">
              <span
                className={clsx(
                  "inline-flex size-10 shrink-0 items-center justify-center rounded-full",
                  failed ? "bg-red-50 text-red-600" : style.iconClass,
                )}
              >
                <Icon aria-hidden className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold text-slate-600">{item.label}</p>
                <p
                  className={clsx(
                    "mt-1 whitespace-nowrap text-[24px] font-bold leading-none tracking-[-0.02em] numeric",
                    failed ? "text-red-700" : style.valueClass,
                  )}
                >
                  {item.value}
                  {item.unit ? (
                    <span className="ml-1.5 text-[11.5px] font-medium tracking-normal text-muted">
                      {item.unit}
                    </span>
                  ) : null}
                </p>
                <p className="mt-2 text-[10.5px] leading-snug text-muted">{item.hint}</p>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}

export interface SyncAgentPresentation {
  id: string;
  name: string;
  facilityCode: string;
  facilityName: string;
  hostname: string | null;
  effectiveStatus: AgentStatus;
  jhcisState: JhcisLinkState;
  pendingBatches: number;
  lastHeartbeatAt: Date | string | null;
  lastSuccessfulSyncAt: Date | string | null;
  lastSyncedVisitDate: string | null;
  lastError: string | null;
  action?: ReactNode;
}

const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  ONLINE: "ออนไลน์",
  SYNCING: "กำลังซิงก์",
  OFFLINE: "ออฟไลน์",
  ERROR: "ผิดพลาด",
  DISABLED: "ปิดใช้งาน",
};

function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        (status === "ONLINE" || status === "SYNCING") && "bg-emerald-50 text-emerald-700",
        status === "ERROR" && "bg-red-50 text-red-700",
        status === "OFFLINE" && "bg-slate-100 text-slate-500",
        status === "DISABLED" && "bg-amber-50 text-amber-700",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {AGENT_STATUS_LABELS[status]}
    </span>
  );
}

export function AgentFleetStatusSummary({
  statuses,
  online,
  totalAgents,
  lastSyncLabel,
  failedBatches24h,
  facilitiesInScope,
}: {
  statuses: AgentStatus[];
  online: number;
  totalAgents: number;
  lastSyncLabel: string;
  failedBatches24h: number;
  facilitiesInScope: number;
}) {
  const counts = statuses.reduce<Record<AgentStatus, number>>(
    (result, status) => {
      result[status] += 1;
      return result;
    },
    { ONLINE: 0, SYNCING: 0, OFFLINE: 0, ERROR: 0, DISABLED: 0 },
  );
  const rows = [
    { label: "กำลังซิงก์", value: counts.SYNCING, dot: "bg-blue-500" },
    { label: "ออนไลน์ (ปกติ)", value: counts.ONLINE, dot: "bg-emerald-500" },
    { label: "ออฟไลน์", value: counts.OFFLINE, dot: "bg-slate-400" },
    { label: "มีปัญหา", value: counts.ERROR, dot: "bg-red-500" },
    { label: "ปิดใช้งาน", value: counts.DISABLED, dot: "bg-amber-500" },
  ];

  return (
    <section className="h-full overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.06)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-cyan-50 text-cyan-600">
          <Wifi aria-hidden className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[14px] font-bold text-slate-900">สถานะ Agent (ปัจจุบัน)</h2>
          <p className="text-[10.5px] text-muted">สรุปจาก heartbeat ล่าสุด</p>
        </div>
      </div>
      <div className="divide-y divide-slate-100 px-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-center gap-2 text-[12px] text-slate-600">
              <span className={clsx("size-2 rounded-full", row.dot)} aria-hidden />
              {row.label}
            </span>
            <span className="numeric text-[13px] font-bold text-slate-900">{formatNumber(row.value)}</span>
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 py-2.5">
          <span className="flex items-center gap-2 text-[12px] font-semibold text-slate-700">
            <Database aria-hidden className="size-4 text-slate-500" />
            ทั้งหมด
          </span>
          <span className="numeric text-[15px] font-bold text-slate-950">{formatNumber(statuses.length)}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-slate-100 bg-slate-100 text-[10.5px]">
        <div className="bg-white px-3 py-2 text-muted">
          Agent ออนไลน์ <strong className="numeric ml-1 text-slate-800">{formatNumber(online)} / {formatNumber(totalAgents)}</strong>
        </div>
        <div className="bg-white px-3 py-2 text-muted">
          ซิงก์ล่าสุด <strong className="ml-1 text-slate-800">{lastSyncLabel}</strong>
        </div>
        <div className="bg-white px-3 py-2 text-muted">
          ซิงก์ล้มเหลว 24 ชม. <strong className={clsx("numeric ml-1", failedBatches24h ? "text-red-700" : "text-slate-800")}>{formatNumber(failedBatches24h)}</strong>
        </div>
        <div className="bg-white px-3 py-2 text-muted">
          สถานบริการในสิทธิ์ <strong className="numeric ml-1 text-slate-800">{formatNumber(facilitiesInScope)}</strong>
        </div>
      </div>
    </section>
  );
}

export function AgentDetailsTable({
  agents,
  canSeeTechnical,
}: {
  agents: SyncAgentPresentation[];
  canSeeTechnical: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.06)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-cyan-50 text-cyan-600">
          <Wifi aria-hidden className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-bold text-slate-900">รายละเอียด Agent</h2>
          <p className="text-[10.5px] text-muted">ข้อมูลปัจจุบันจาก heartbeat และสถานะคิวจริง</p>
        </div>
      </div>
      {agents.length ? (
        <div className="max-h-[540px] overflow-x-auto overflow-y-auto overscroll-contain">
          <table className="w-full min-w-[1120px] border-collapse text-[11.5px]">
            <thead className="sticky top-0 z-10 bg-slate-50 text-left text-[10.5px] font-semibold text-slate-500 shadow-[0_1px_0_rgba(226,232,240,1)]">
              <tr className="border-b border-slate-200">
                <th className="px-4 py-2.5">Agent / สถานบริการ</th>
                <th className="px-3 py-2.5">สถานะ</th>
                <th className="px-3 py-2.5">JHCIS</th>
                <th className="px-3 py-2.5 text-right">คิวค้างส่ง</th>
                <th className="px-3 py-2.5">Heartbeat</th>
                <th className="px-3 py-2.5">ซิงก์สำเร็จล่าสุด</th>
                <th className="px-3 py-2.5">ข้อมูลล่าสุด</th>
                <th className="px-4 py-2.5 text-right">การทำงาน</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.id} className="border-b border-slate-100 align-top last:border-0 hover:bg-blue-50/30">
                  <td className="px-4 py-2.5">
                    <p className="font-semibold text-slate-800">{agent.name}</p>
                    <p className="mt-0.5 text-[10px] text-muted">{agent.facilityCode} · {agent.facilityName}{agent.hostname ? ` · ${agent.hostname}` : ""}</p>
                    {agent.lastError ? <p className="mt-1 max-w-[280px] truncate text-[10px] text-red-600" title={canSeeTechnical ? agent.lastError : undefined}>{canSeeTechnical ? agent.lastError : "พบปัญหา กรุณาแจ้งผู้ดูแลระบบ"}</p> : null}
                  </td>
                  <td className="px-3 py-2.5"><AgentStatusBadge status={agent.effectiveStatus} /></td>
                  <td className="px-3 py-2.5 text-slate-600">{JHCIS_LINK_LABELS[agent.jhcisState]}</td>
                  <td className={clsx("numeric px-3 py-2.5 text-right", agent.pendingBatches ? "font-semibold text-amber-700" : "text-slate-500")}>{agent.pendingBatches ? `${formatNumber(agent.pendingBatches)} ชุด` : "ไม่มี"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{relativeTime(agent.lastHeartbeatAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{formatDateTime(agent.lastSuccessfulSyncAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-600">{formatDate(agent.lastSyncedVisitDate)}</td>
                  <td className="px-4 py-2.5 text-right">{agent.action ? <div className="inline-block no-print">{agent.action}</div> : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-5 py-9 text-center text-xs text-muted">ยังไม่มี Agent ในขอบเขตสิทธิ์นี้</div>
      )}
    </section>
  );
}

function Fact({ icon, label, value, tone = "default" }: {
  icon: typeof Activity;
  label: string;
  value: ReactNode;
  tone?: "default" | "ok" | "warn" | "danger";
}) {
  const Icon = icon;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.025em] text-slate-400">
        <Icon aria-hidden className="size-3.5" />
        {label}
      </div>
      <div
        className={clsx(
          "mt-1 truncate text-[12.5px] font-medium",
          tone === "ok" && "text-emerald-700",
          tone === "warn" && "text-amber-700",
          tone === "danger" && "text-red-700",
          tone === "default" && "text-slate-700",
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function AgentStatusPanel({
  agents,
  canSeeTechnical,
}: {
  agents: SyncAgentPresentation[];
  canSeeTechnical: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.06)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3 sm:px-5">
        <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-blue-50 text-blue-600">
          <Wifi aria-hidden className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-bold text-slate-900">สถานะ Agent</h2>
          <p className="text-[11px] text-muted">สถานะปัจจุบันจาก heartbeat และข้อมูลซิงก์จริง</p>
        </div>
      </div>

      {agents.length ? (
        <div className="grid max-h-[340px] gap-px overflow-y-auto overscroll-contain bg-slate-100 lg:grid-cols-2">
          {agents.map((agent) => {
            const jhcisTone =
              agent.jhcisState === "CONNECTED"
                ? "ok"
                : agent.jhcisState === "UNREACHABLE"
                  ? "danger"
                  : "default";
            return (
              <article key={agent.id} className="bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-bold text-slate-900">{agent.name}</p>
                    <p className="mt-0.5 truncate text-[11px] text-muted">
                      {agent.facilityCode} · {agent.facilityName}
                      {agent.hostname ? ` · ${agent.hostname}` : ""}
                    </p>
                  </div>
                  <AgentStatusBadge status={agent.effectiveStatus} />
                </div>

                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4">
                  <Fact icon={Database} label="JHCIS" value={JHCIS_LINK_LABELS[agent.jhcisState]} tone={jhcisTone} />
                  <Fact
                    icon={Activity}
                    label="คิวค้างส่ง"
                    value={agent.pendingBatches ? `${formatNumber(agent.pendingBatches)} ชุด` : "ไม่มี"}
                    tone={agent.pendingBatches ? "warn" : "ok"}
                  />
                  <Fact icon={Clock3} label="Heartbeat" value={relativeTime(agent.lastHeartbeatAt)} />
                  <Fact icon={CircleCheckBig} label="ซิงก์สำเร็จล่าสุด" value={formatDateTime(agent.lastSuccessfulSyncAt)} />
                </div>

                <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[11px] text-muted">
                    ข้อมูลถึงวันที่ <span className="font-semibold text-slate-700">{formatDate(agent.lastSyncedVisitDate)}</span>
                  </p>
                  {agent.action ? <div className="shrink-0 no-print">{agent.action}</div> : null}
                </div>

                {agent.lastError ? (
                  <div className="mt-2 rounded-[8px] bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-red-700">
                    {canSeeTechnical ? agent.lastError : "พบปัญหา กรุณาแจ้งผู้ดูแลระบบ"}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="px-5 py-10 text-center">
          <Server aria-hidden className="mx-auto size-8 text-slate-300" />
          <p className="mt-2 text-sm font-semibold text-slate-700">ยังไม่มี Agent</p>
          <p className="mt-1 text-xs text-muted">ติดต่อผู้ดูแลระบบส่วนกลางเพื่อสร้างและติดตั้ง Agent</p>
        </div>
      )}
    </section>
  );
}

export interface RunningSyncPresentation {
  batchRef: string;
  facilityCode: string;
  agentName: string;
  rangeFrom: string | null;
  rangeTo: string | null;
  recordsRead: number;
  recordsAccepted: number;
  recordsRejected: number;
  progress: number;
}

export function RunningSyncPanel({ batches }: { batches: RunningSyncPresentation[] }) {
  if (!batches.length) return null;

  return (
    <section className="overflow-hidden rounded-[16px] border border-slate-200/85 bg-white shadow-[0_8px_28px_rgba(31,78,112,0.06)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3 sm:px-5">
        <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-violet-50 text-violet-600">
          <Activity aria-hidden className="size-[18px]" />
        </span>
        <div>
          <h2 className="text-[15px] font-bold text-slate-900">กำลังนำเข้าข้อมูล</h2>
          <p className="text-[11px] text-muted">ความคืบหน้าของรอบที่กำลังทำงานจริง</p>
        </div>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        {batches.map((batch) => {
          const done = batch.recordsAccepted + batch.recordsRejected;
          const percent = Math.round(batch.progress * 100);
          return (
            <article key={batch.batchRef}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[13px] font-bold text-slate-900">
                    {batch.facilityCode} · {batch.agentName}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted numeric">{batch.batchRef}</p>
                  {batch.rangeFrom && batch.rangeTo ? (
                    <p className="mt-0.5 text-[11px] text-muted">
                      ข้อมูล {formatDate(batch.rangeFrom)} – {formatDate(batch.rangeTo)}
                    </p>
                  ) : null}
                </div>
                <p className="text-right text-[11px] text-muted numeric">
                  <span className="block text-[14px] font-bold text-slate-900">
                    {formatNumber(done)} / {formatNumber(batch.recordsRead)}
                  </span>
                  {percent}%
                </p>
              </div>
              <div
                className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100"
                role="progressbar"
                aria-label={`ความคืบหน้า ${batch.batchRef}`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-[width] duration-300"
                  style={{ width: `${Math.max(2, percent)}%` }}
                />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function SyncSetupCard({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: "download" | "enroll";
  children: ReactNode;
}) {
  const Icon = icon === "download" ? Server : Building2;
  return (
    <section className="flex h-full flex-col overflow-hidden rounded-[14px] border border-slate-200/85 bg-white shadow-[0_6px_20px_rgba(31,78,112,0.045)]">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3">
        <span className="inline-flex size-8 items-center justify-center rounded-[10px] bg-slate-100 text-slate-600">
          <Icon aria-hidden className="size-[17px]" />
        </span>
        <div>
          <h2 className="text-[14px] font-bold text-slate-900">{title}</h2>
          <p className="text-[10.5px] text-muted">{description}</p>
        </div>
      </div>
      <div className="flex-1 p-4">{children}</div>
    </section>
  );
}

export function SyncSetupScrollArea({ children }: { children: ReactNode }) {
  return (
    <div
      data-visible-agent-limit="10"
      className="max-h-[720px] space-y-2.5 overflow-y-auto overscroll-contain pr-1"
    >
      {children}
    </div>
  );
}
