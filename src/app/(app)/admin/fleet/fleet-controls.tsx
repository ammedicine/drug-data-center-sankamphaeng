"use client";

import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Notice, inputClass } from "@/components/ui/primitives";
import { toThaiDate, type ControlAckState } from "@/lib/shared/sync-control";

import {
  cancelAgentUpdateAction,
  pauseAgentSyncAction,
  requestAgentUpdateAction,
  resumeAgentSyncAction,
  type ActionState,
} from "../actions";
import { UPDATE_ERROR_LABELS, UPDATE_STATE_LABELS, type UpdateErrorCode } from "@/lib/shared/update-command";

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

  /* ------------------------------------------------------ software update */
  supportsRemoteUpdate: boolean;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** the newest command row for this agent, or null */
  command: {
    id: string;
    status: string;
    targetVersion: string;
    requestedAtLabel: string;
    requestedByName: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    terminal: boolean;
    completedAtLabel: string | null;
  } | null;
  /** the agent's own last word about its updater */
  updater: {
    state: string | null;
    checkedAtLabel: string | null;
    succeededAtLabel: string | null;
    errorCode: string | null;
    error: string | null;
    errorAtLabel: string | null;
    task: Record<string, unknown> | null;
  };
}

/**
 * What the update column says, in Thai, without needing a log.
 *
 * The command row is the record; the agent's own report refines it. An
 * offline machine with a REQUESTED row is "waiting for the machine", not
 * "waiting for the agent" - the difference is whether anyone needs to go
 * and switch something on.
 */
function updateLabel(row: FleetRowView): { text: string; tone: "ok" | "warn" | "danger" | "muted" } {
  const c = row.command;
  if (c && !c.terminal) {
    if (c.status === "REQUESTED" && row.status === "OFFLINE") {
      return { text: UPDATE_STATE_LABELS.OFFLINE_REQUESTED, tone: "warn" };
    }
    const label = UPDATE_STATE_LABELS[c.status as keyof typeof UPDATE_STATE_LABELS] ?? c.status;
    return { text: `${label} → ${c.targetVersion}`, tone: "warn" };
  }
  if (c?.status === "FAILED") {
    const reason = c.errorCode ? (UPDATE_ERROR_LABELS[c.errorCode as UpdateErrorCode] ?? c.errorCode) : null;
    return { text: `${UPDATE_STATE_LABELS.FAILED}${reason ? ` · ${reason}` : ""}`, tone: "danger" };
  }
  if (!row.supportsRemoteUpdate) {
    return { text: "รุ่นนี้อัปเดตเองตามรอบ 30 นาที (ยังไม่รับคำสั่งจากศูนย์กลาง)", tone: "muted" };
  }
  if (!row.updateAvailable) return { text: UPDATE_STATE_LABELS.ALREADY_UP_TO_DATE, tone: "ok" };
  if (c?.status === "SUCCESS") return { text: `${UPDATE_STATE_LABELS.SUCCESS} ${c.completedAtLabel ?? ""}`, tone: "ok" };
  return { text: `มีรุ่น ${row.latestVersion} ให้อัปเดต`, tone: "warn" };
}

const TONE_CLASS = { ok: "text-emerald-700", warn: "text-amber-700", danger: "text-rose-700", muted: "text-slate-500" } as const;

const FILTERS = [
  { key: "all", label: "ทั้งหมด" },
  { key: "online", label: "ออนไลน์" },
  { key: "offline", label: "ออฟไลน์" },
  { key: "running", label: "กำลังทำงาน" },
  { key: "paused", label: "หยุดแล้ว" },
  { key: "waiting", label: "รอรับคำสั่ง" },
  { key: "problem", label: "มีปัญหา" },
  { key: "updatable", label: "มีรุ่นใหม่" },
  { key: "updating", label: "กำลังอัปเดต" },
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
  const [updateState, requestUpdate] = useActionState(requestAgentUpdateAction, {} as ActionState);
  const [cancelState, cancelUpdate] = useActionState(cancelAgentUpdateAction, {} as ActionState);
  const [confirmUpdate, setConfirmUpdate] = useState<null | "one" | "selected">(null);
  const [updateTarget, setUpdateTarget] = useState<string | null>(null);
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
        case "updatable":
          return r.updateAvailable;
        case "updating":
          return Boolean(r.command && !r.command.terminal);
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
      {updateState.error || updateState.success ? (
        <Notice tone={updateState.error ? "danger" : "ok"}>
          {updateState.error ?? updateState.success}
        </Notice>
      ) : null}
      {cancelState.error || cancelState.success ? (
        <Notice tone={cancelState.error ? "danger" : "ok"}>
          {cancelState.error ?? cancelState.success}
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

        {/* Remote software update for the selection. Confirmed first, with the
            machines listed, because a click here installs software on real
            clinic PCs. Every agent gets its own command; the centre hands them
            out no more than two at a time. */}
        {confirmUpdate === "selected" ? (
          <form action={requestUpdate} className="flex w-full flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3">
            {selectedRows.map((r) => (
              <input key={r.agentId} type="hidden" name="agentId" value={r.agentId} />
            ))}
            <input type="hidden" name="scope" value="selected" />
            <div className="text-sm font-medium">
              จะสั่งอัปเดต {selectedRows.length} Agent เป็นรุ่นล่าสุด{selectedRows[0]?.latestVersion ? ` (${selectedRows[0].latestVersion})` : ""}
            </div>
            <ul className="max-h-40 overflow-y-auto text-xs text-slate-700">
              {selectedRows.map((r) => (
                <li key={r.agentId}>
                  {r.facilityName} · {r.agentName} · ปัจจุบัน {r.version ?? "-"}
                  {!r.supportsRemoteUpdate ? " · รุ่นนี้ไม่รับคำสั่ง จะถูกข้าม" : ""}
                  {!r.updateAvailable ? " · เป็นรุ่นล่าสุดแล้ว จะถูกข้าม" : ""}
                  {r.status === "OFFLINE" ? " · ออฟไลน์ จะรอจนกว่าเครื่องออนไลน์" : ""}
                </li>
              ))}
            </ul>
            <div className="text-xs text-slate-600">
              ศูนย์กลางจะปล่อยให้ติดตั้งครั้งละไม่เกิน 2 เครื่อง · Agent ที่กำลังซิงก์จะรอให้ซิงก์เสร็จก่อน · เครื่องที่ปิดอยู่จะได้รับคำสั่งเมื่อเปิด
            </div>
            <div className="flex gap-2">
              <Submit label={`ยืนยันอัปเดต ${selectedRows.length} Agent`} variant="primary" />
              <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmUpdate(null)}>
                ยกเลิก
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!selectedRows.length}
            onClick={() => setConfirmUpdate("selected")}
          >
            อัปเดตที่เลือก
          </Button>
        )}

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
              <th className="p-2">อัปเดตซอฟต์แวร์</th>
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
                  {(() => {
                    const label = updateLabel(r);
                    return <div className={TONE_CLASS[label.tone]}>{label.text}</div>;
                  })()}
                  <div className="text-xs text-slate-500">
                    {r.latestVersion ? `ล่าสุด ${r.latestVersion}` : "ยังไม่มีรุ่นเผยแพร่"}
                    {r.updater.checkedAtLabel ? ` · ตรวจ ${r.updater.checkedAtLabel}` : ""}
                    {r.updater.succeededAtLabel ? ` · สำเร็จ ${r.updater.succeededAtLabel}` : ""}
                  </div>
                  {r.updater.errorCode && !(r.command && !r.command.terminal) ? (
                    <div className="text-xs text-rose-700">
                      {UPDATE_ERROR_LABELS[r.updater.errorCode as UpdateErrorCode] ?? r.updater.errorCode}
                      {r.updater.errorAtLabel ? ` (${r.updater.errorAtLabel})` : ""}
                    </div>
                  ) : null}
                  {r.command && !r.command.terminal ? (
                    <div className="text-xs text-slate-500">
                      สั่งโดย {r.command.requestedByName ?? "-"} {r.command.requestedAtLabel}
                      {r.command.status === "REQUESTED" ? (
                        <form action={cancelUpdate} className="mt-1">
                          <input type="hidden" name="commandId" value={r.command.id} />
                          <Submit label="ยกเลิกคำสั่ง" />
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                  {r.updater.task && typeof r.updater.task === "object" && "present" in r.updater.task && r.updater.task.present === false ? (
                    <div className="text-xs text-rose-700">⚠ ไม่พบงานตรวจรุ่นใหม่ในเครื่อง</div>
                  ) : null}
                  {r.supportsRemoteUpdate && r.updateAvailable && !(r.command && !r.command.terminal) ? (
                    confirmUpdate === "one" && updateTarget === r.agentId ? (
                      <form action={requestUpdate} className="mt-1 flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-2">
                        <input type="hidden" name="agentId" value={r.agentId} />
                        <input type="hidden" name="scope" value="selected" />
                        <div className="text-xs">
                          {r.facilityName} · {r.agentName}
                          <br />
                          {r.version ?? "-"} → {r.latestVersion}
                          {r.status === "OFFLINE" ? (
                            <>
                              <br />
                              <span className="text-amber-700">เครื่องออฟไลน์ คำสั่งจะรอจนกว่าเครื่องออนไลน์</span>
                            </>
                          ) : null}
                        </div>
                        <div className="flex gap-1">
                          <Submit label="ยืนยัน" variant="primary" />
                          <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmUpdate(null)}>
                            ยกเลิก
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setUpdateTarget(r.agentId);
                          setConfirmUpdate("one");
                        }}
                      >
                        อัปเดตตอนนี้
                      </Button>
                    )
                  ) : null}
                </td>
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
                <td colSpan={13} className="p-6 text-center text-slate-500">
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
