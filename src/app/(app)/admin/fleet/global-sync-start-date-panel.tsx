"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Card, Notice, inputClass } from "@/components/ui/primitives";
import type { GlobalSyncStartDateReadinessStatus } from "@/lib/services/global-sync-policy-management";
import { toThaiDate } from "@/lib/shared/sync-control";

import {
  activateGlobalSyncStartDateAction,
  saveGlobalSyncStartDateAction,
  type ActionState,
} from "../actions";

export interface GlobalSyncStartDatePanelPolicy {
  desiredDate: string;
  desiredRevision: number;
  activeDate: string | null;
  activeRevision: number;
}

export interface GlobalSyncStartDatePanelAgent {
  agentId: string;
  label: string;
  status: GlobalSyncStartDateReadinessStatus;
  paused: boolean;
}

function Submit({ label, variant = "primary" }: { label: string; variant?: "primary" | "secondary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" variant={variant} disabled={pending}>
      {pending ? "กำลังบันทึก..." : label}
    </Button>
  );
}

const STATUS_LABEL: Record<GlobalSyncStartDateReadinessStatus, string> = {
  APPLIED: "APPLIED",
  PENDING: "PENDING",
  UNSUPPORTED: "UNSUPPORTED",
};

export function GlobalSyncStartDatePanel({
  policy,
  agents,
}: {
  policy: GlobalSyncStartDatePanelPolicy | null;
  agents: GlobalSyncStartDatePanelAgent[];
}) {
  const [saveState, save] = useActionState(saveGlobalSyncStartDateAction, {} as ActionState);
  const [activateState, activate] = useActionState(
    activateGlobalSyncStartDateAction,
    {} as ActionState,
  );
  const outstanding = agents.filter((agent) => agent.status !== "APPLIED");

  return (
    <Card>
      <div className="space-y-4 p-4">
        {saveState.error || saveState.success ? (
          <Notice tone={saveState.error ? "danger" : "ok"}>
            {saveState.error ?? saveState.success}
          </Notice>
        ) : null}
        {activateState.error || activateState.success ? (
          <Notice tone={activateState.error ? "danger" : "ok"}>
            {activateState.error ?? activateState.success}
          </Notice>
        ) : null}

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <div className="text-xs text-slate-500">ค่าที่ต้องการ</div>
            <div className="font-medium">
              {policy ? `${toThaiDate(policy.desiredDate)} · revision ${policy.desiredRevision}` : "ยังไม่ได้กำหนด"}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">ค่าที่กำลังบังคับใช้</div>
            <div className="font-medium">
              {policy?.activeDate
                ? `${toThaiDate(policy.activeDate)} · revision ${policy.activeRevision}`
                : "ยังไม่บังคับใช้"}
            </div>
          </div>
        </div>

        <form action={save} className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-500">Global Sync Start Date</span>
            <input
              type="date"
              name="desiredDate"
              defaultValue={policy?.desiredDate ?? ""}
              required
              className={inputClass}
            />
          </label>
          <input
            type="hidden"
            name="expectedDesiredRevision"
            value={policy?.desiredRevision ?? 0}
          />
          <Submit label="บันทึกค่าที่ต้องการ" />
          <span className="text-xs text-slate-500">การบันทึกอย่างเดียวยังไม่เปลี่ยนการรับข้อมูล</span>
        </form>

        {policy && policy.activeRevision !== policy.desiredRevision ? (
          <form action={activate} className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <input type="hidden" name="expectedDesiredRevision" value={policy.desiredRevision} />
            <div className="text-sm font-medium">
              พร้อม {agents.length - outstanding.length}/{agents.length} Agent
            </div>
            {outstanding.length ? (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="overridePending" value="yes" className="mt-1" />
                  <span>ยืนยันเปิดใช้โดยข้าม Agent ที่ยัง PENDING/UNSUPPORTED และหยุดจากศูนย์กลางอยู่</span>
                </label>
                <input
                  name="overrideReason"
                  placeholder="เหตุผลที่ต้องข้าม Agent ที่ยังไม่พร้อม"
                  className={`${inputClass} w-full`}
                />
              </>
            ) : null}
            <Submit label={`เปิดใช้ revision ${policy.desiredRevision}`} variant="danger" />
          </form>
        ) : null}

        {policy ? <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="p-2">Agent</th><th className="p-2">Policy</th><th className="p-2">Pause</th></tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.agentId} className="border-t border-slate-100">
                  <td className="p-2">{agent.label}</td>
                  <td className="p-2">{STATUS_LABEL[agent.status]}</td>
                  <td className="p-2">{agent.paused ? "PAUSED" : "RUNNING"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div> : (
          <p className="text-sm text-slate-500">
            Agent ยังทำงานตามค่า legacy จนกว่าจะบันทึก managed policy ครั้งแรก
          </p>
        )}
      </div>
    </Card>
  );
}
