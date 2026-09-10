"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Notice, inputClass } from "@/components/ui/primitives";
import { toThaiDate, type ControlAckState } from "@/lib/shared/sync-control";

import { pauseAgentSyncAction, resumeAgentSyncAction, type ActionState } from "../actions";

/**
 * One row per agentId, never per facility.
 *
 * A สถานบริการ may have more than one Agent - the schema has never prevented
 * it - and collapsing them would let somebody pause a machine they could not
 * see. Pausing is always per agentId; a facility-wide pause is a deliberate
 * selection of its rows, not a side effect of the layout.
 */
export interface FleetRowView {
  agentId: string;
  agentName: string;
  hostname: string | null;
  facilityCode: string;
  facilityName: string;
  pcucode: string | null;
  version: string | null;
  buildId: string | null;
  status: string;
  jhcis: string;
  desiredSyncState: "RUNNING" | "PAUSED";
  effectiveSyncState: string | null;
  ack: ControlAckState;
  ingestAllowed: boolean;
  syncStartDate: string | null;
  lastSeenLabel: string;
  pendingBatches: number;
  problem: boolean;
  current: { recordsRead: number; recordsAccepted: number; progress: number } | null;
  supportsRemotePause: boolean;
}

const FILTERS = [
  { key: "all", label: "ทั้งหมด" },
  { key: "online", label: "ออนไลน์" },
  { key: "offline", label: "ออฟไลน์" },
  { key: "running", label: "กำลังทำงาน" },
  { key: "paused", label: "หยุดแล้ว" },
  { key: "waiting", label: "รอรับคำสั่ง" },
  { key: "problem", label: "มีปัญหา" },
] as const;

/** Text and an icon, never colour alone. */
function ControlPill({ row }: { row: FleetRowView }) {
  if (row.desiredSyncState === "RUNNING") {
    return row.ack === "RESUME_PENDING" ? (
      <span className="text-amber-700">⏳ กำลังรอ Agent กลับมาทำงาน</span>
    ) : (
      <span className="text-emerald-700">🟢 กำลังทำงาน</span>
    );
  }
  if (row.ack === "IN_SYNC") return <span className="text-amber-700">🟠 หยุดการซิงก์แล้ว</span>;
  if (row.ack === "UNSUPPORTED") {
    // The honest description of a v1.1.7 machine: the centre is refusing its
    // data, and it will never say anything about the instruction because it
    // has no idea one exists.
    return (
      <span className="text-amber-700">
        🔒 ศูนย์กลางบล็อกข้อมูลแล้ว · Agent รุ่นนี้ยังไม่รองรับการรับคำสั่ง
      </span>
    );
  }
  return <span className="text-amber-700">⏳ ศูนย์กลางบล็อกแล้ว · รอ Agent รับคำสั่ง</span>;
}

function Submit({ label, variant = "secondary" }: { label: string; variant?: "primary" | "secondary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? "กำลังส่ง..." : label}
    </Button>
  );
}

export function FleetControls({ rows }: { rows: FleetRowView[] }) {
  const [pauseState, pause] = useActionState(pauseAgentSyncAction, {} as ActionState);
  const [resumeState, resume] = useActionState(resumeAgentSyncAction, {} as ActionState);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<null | "pauseAll" | "resumeAll">(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (needle) {
        const haystack = [r.facilityName, r.facilityCode, r.pcucode, r.agentName, r.agentId]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      switch (filter) {
        case "online":
          return r.status !== "OFFLINE";
        case "offline":
          return r.status === "OFFLINE";
        case "running":
          return r.desiredSyncState === "RUNNING";
        case "paused":
          return r.desiredSyncState === "PAUSED";
        case "waiting":
          return r.ack === "PAUSE_PENDING" || r.ack === "RESUME_PENDING";
        case "problem":
          return r.problem;
        default:
          return true;
      }
    });
  }, [rows, filter, query]);

  const toggle = (agentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const selectedRows = rows.filter((r) => selected.has(r.agentId));
  const pausedCount = rows.filter((r) => r.desiredSyncState === "PAUSED").length;

  return (
    <div className="space-y-4">
      {pauseState.error || pauseState.success ? (
        <Notice tone={pauseState.error ? "danger" : "ok"}>
          {pauseState.error ?? pauseState.success}
        </Notice>
      ) : null}
      {resumeState.error || resumeState.success ? (
        <Notice tone={resumeState.error ? "danger" : "ok"}>
          {resumeState.error ?? resumeState.success}
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-xs ${
              filter === f.key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-300 bg-white text-slate-600"
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ค้นหาสถานบริการ / pcucode / ชื่อ Agent"
          className={`${inputClass} ml-auto w-full max-w-xs`}
        />
      </div>

      {/* Bulk actions. Kept apart from anything destructive on purpose: this
          page pauses and resumes, and never deletes. */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <span className="text-sm text-slate-600">
          เลือกไว้ {selectedRows.length} จาก {rows.length} Agent
        </span>
        <form action={pause} className="contents">
          {selectedRows.map((r) => (
            <input key={r.agentId} type="hidden" name="agentId" value={r.agentId} />
          ))}
          <input type="hidden" name="scope" value="selected" />
          <input
            name="reason"
            placeholder="เหตุผล (ไม่บังคับ)"
            className={`${inputClass} w-56`}
          />
          <Submit label={`หยุดการซิงก์ ${selectedRows.length} Agent`} />
        </form>
        <form action={resume} className="contents">
          {selectedRows.map((r) => (
            <input key={r.agentId} type="hidden" name="agentId" value={r.agentId} />
          ))}
          <input type="hidden" name="scope" value="selected" />
          <Submit label={`เปิดการซิงก์ ${selectedRows.length} Agent`} />
        </form>

        <div className="ml-auto flex items-center gap-2">
          {confirming === "pauseAll" ? (
            <form action={pause} className="flex items-center gap-2">
              <input type="hidden" name="scope" value="all" />
              <input
                name="reason"
                placeholder="เหตุผล"
                className={`${inputClass} w-56`}
              />
              <span className="text-xs text-slate-600">
                จะหยุด {rows.length} Agent · Agent จะยังออนไลน์ แต่ศูนย์กลางจะบล็อกข้อมูลใหม่ทันที
              </span>
              <Submit label={`ยืนยันหยุด ${rows.length} Agent`} variant="danger" />
              <Button type="button" size="sm" variant="secondary" onClick={() => setConfirming(null)}>
                ยกเลิก
              </Button>
            </form>
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirming("pauseAll")}>
              หยุดการซิงก์ทั้งหมด
            </Button>
          )}
          {confirming === "resumeAll" ? (
            <form action={resume} className="flex items-center gap-2">
              <input type="hidden" name="scope" value="all" />
              <span className="text-xs text-slate-600">
                จะเปิด {pausedCount} Agent ที่หยุดอยู่
              </span>
              <Submit label="ยืนยันเปิดทั้งหมด" />
              <Button type="button" size="sm" variant="secondary" onClick={() => setConfirming(null)}>
                ยกเลิก
              </Button>
            </form>
          ) : (
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirming("resumeAll")}>
              เปิดการซิงก์ทั้งหมด
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[64rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="p-2 w-8" />
              <th className="p-2">สถานบริการ</th>
              <th className="p-2">Agent</th>
              <th className="p-2">เวอร์ชัน</th>
              <th className="p-2">สถานะ</th>
              <th className="p-2">JHCIS</th>
              <th className="p-2">สถานะการซิงก์</th>
              <th className="p-2">ศูนย์กลาง</th>
              <th className="p-2">เริ่มเก็บข้อมูล</th>
              <th className="p-2">งานปัจจุบัน</th>
              <th className="p-2">เห็นล่าสุด</th>
              <th className="p-2">คำสั่ง</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.agentId} className="border-t border-slate-100 align-top">
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={selected.has(r.agentId)}
                    onChange={() => toggle(r.agentId)}
                    aria-label={`เลือก ${r.facilityName}`}
                  />
                </td>
                <td className="p-2">
                  <div className="font-medium">{r.facilityName}</div>
                  <div className="text-xs text-slate-500">{r.pcucode ?? r.facilityCode}</div>
                </td>
                <td className="p-2">
                  <div>{r.agentName}</div>
                  <div className="text-xs text-slate-500">{r.agentId.slice(0, 8)}…</div>
                </td>
                <td className="p-2">
                  <div>{r.version ?? "-"}</div>
                  {r.buildId ? (
                    <div className="text-xs text-slate-500">{r.buildId.slice(0, 7)}</div>
                  ) : (
                    <div className="text-xs text-slate-400">ไม่ทราบ build</div>
                  )}
                </td>
                <td className="p-2">
                  {r.status === "OFFLINE" ? (
                    <span className="text-rose-700">🔴 ออฟไลน์</span>
                  ) : (
                    <span className="text-emerald-700">🟢 ออนไลน์</span>
                  )}
                </td>
                <td className="p-2">
                  {r.jhcis === "CONNECTED" ? (
                    <span className="text-emerald-700">เชื่อมต่อ</span>
                  ) : r.jhcis === "UNREACHABLE" ? (
                    <span className="text-rose-700">⚠ เชื่อมต่อไม่ได้</span>
                  ) : (
                    <span className="text-slate-500">ไม่ทราบสถานะ</span>
                  )}
                </td>
                <td className="p-2">
                  <ControlPill row={r} />
                </td>
                <td className="p-2">
                  {r.ingestAllowed ? (
                    <span className="text-slate-600">อนุญาต</span>
                  ) : (
                    <span className="text-amber-700">🔒 บล็อก</span>
                  )}
                </td>
                <td className="p-2">
                  {r.syncStartDate ? (
                    toThaiDate(r.syncStartDate)
                  ) : (
                    <span className="text-slate-400">ยังไม่รองรับ</span>
                  )}
                </td>
                <td className="p-2">
                  {r.current ? (
                    <span>
                      {r.current.recordsAccepted.toLocaleString("th-TH")} /{" "}
                      {r.current.recordsRead.toLocaleString("th-TH")} (
                      {Math.round(r.current.progress * 100)}%)
                    </span>
                  ) : (
                    <span className="text-slate-400">ว่าง</span>
                  )}
                </td>
                <td className="p-2 text-slate-600">{r.lastSeenLabel}</td>
                <td className="p-2">
                  {r.desiredSyncState === "RUNNING" ? (
                    <form action={pause} className="flex flex-col gap-1">
                      <input type="hidden" name="agentId" value={r.agentId} />
                      <input type="hidden" name="scope" value="selected" />
                      <input
                        name="reason"
                        placeholder="เหตุผล"
                        className={`${inputClass} w-40 text-xs`}
                      />
                      <Submit label="หยุดการซิงก์" />
                    </form>
                  ) : (
                    <form action={resume}>
                      <input type="hidden" name="agentId" value={r.agentId} />
                      <input type="hidden" name="scope" value="selected" />
                      <Submit label="เปิดการซิงก์" variant="primary" />
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {!visible.length ? (
              <tr>
                <td colSpan={12} className="p-6 text-center text-slate-500">
                  ไม่พบ Agent ตามเงื่อนไขที่เลือก
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
