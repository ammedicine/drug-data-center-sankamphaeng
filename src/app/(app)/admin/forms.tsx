"use client";

import { useActionState, useState } from "react";
import { ChevronUp, Plus } from "lucide-react";
import { useFormStatus } from "react-dom";

import { Button, Field, Notice, inputClass } from "@/components/ui/primitives";

import {
  createAgentAction,
  createFacilityAction,
  createUserAction,
  reissueEnrollmentTokenAction,
  requestSyncAction,
  requestVerifyAction,
  revokeAgentAction,
  toggleFacilityAction,
  toggleUserAction,
  type ActionState,
} from "./actions";

function Feedback({ state }: { state: ActionState }) {
  if (!state.error && !state.success) return null;
  return (
    <Notice tone={state.error ? "danger" : "ok"}>{state.error ?? state.success}</Notice>
  );
}

function Submit({ label, variant = "primary" }: { label: string; variant?: "primary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} size="sm">
      {pending ? "กำลังบันทึก..." : label}
    </Button>
  );
}

/** Enrollment token is displayed once; it is never persisted in plaintext. */
function TokenPanel({ state }: { state: ActionState }) {
  if (!state.enrollmentToken) return null;
  return (
    <div className="rounded-[8px] border border-brand-line bg-brand-soft p-4">
      <p className="text-xs font-semibold text-brand-ink">
        รหัสลงทะเบียน (แสดงครั้งเดียว - หมดอายุ{" "}
        {state.enrollmentExpiresAt
          ? new Date(state.enrollmentExpiresAt).toLocaleString("th-TH")
          : "-"}
        )
      </p>
      <code className="mt-2 block break-all rounded-[6px] border border-brand-line bg-surface px-3 py-2 text-xs text-ink">
        {state.enrollmentToken}
      </code>
      <p className="mt-2 text-xs text-brand-ink">
        คัดลอกไปวางในโปรแกรมเชื่อมข้อมูลที่เครื่องของ รพ.สต. ที่แท็บ &quot;ตั้งค่า&quot; &rarr;
        ลงทะเบียนกับระบบศูนย์กลาง · <span className="font-medium">ห้ามส่งผ่านช่องทางสาธารณะ</span>
      </p>
    </div>
  );
}

export function CollapsibleForm({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        icon={open ? ChevronUp : Plus}
      >
        {open ? "ปิดฟอร์ม" : label}
      </Button>
      {open ? children : null}
    </div>
  );
}

export function FacilityForm() {
  const [state, action] = useActionState<ActionState, FormData>(createFacilityAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="sm:col-span-2 lg:col-span-3">
        <Feedback state={state} />
      </div>
      <Field label="รหัสสถานบริการ">
        <input name="code" required className={inputClass} placeholder="RPST-01" />
      </Field>
      <Field label="pcucode ของ JHCIS" hint="ตัวเลข 5 หลัก เช่น 05957 (อ่านจาก office.offid)">
        <input name="jhcisPcucode" required maxLength={5} className={inputClass} placeholder="05957" />
      </Field>
      <Field label="ชื่อสถานบริการ">
        <input name="name" required className={inputClass} placeholder="รพ.สต.บ้าน..." />
      </Field>
      <Field label="จังหวัด">
        <input name="province" className={inputClass} defaultValue="เชียงใหม่" />
      </Field>
      <Field label="อำเภอ">
        <input name="district" className={inputClass} defaultValue="สันกำแพง" />
      </Field>
      <Field label="ตำบล">
        <input name="subdistrict" className={inputClass} />
      </Field>
      <div className="flex items-end">
        <Submit label="เพิ่มสถานบริการ" />
      </div>
    </form>
  );
}

export function FacilityToggleForm({
  facilityId,
  isActive,
}: {
  facilityId: string;
  isActive: boolean;
}) {
  const [, action] = useActionState<ActionState, FormData>(toggleFacilityAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="facilityId" value={facilityId} />
      <input type="hidden" name="isActive" value={String(!isActive)} />
      <Submit label={isActive ? "ปิดใช้งาน" : "เปิดใช้งาน"} variant={isActive ? "danger" : "primary"} />
    </form>
  );
}

export function AgentForm({
  facilities,
}: {
  facilities: Array<{ id: string; code: string; name: string }>;
}) {
  const [state, action] = useActionState<ActionState, FormData>(createAgentAction, {});
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="sm:col-span-2 lg:col-span-4 space-y-3">
        <Feedback state={state} />
        <TokenPanel state={state} />
      </div>
      <Field label="สถานบริการ">
        <select name="facilityId" required className={inputClass}>
          {facilities.map((f) => (
            <option key={f.id} value={f.id}>
              {f.code} · {f.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="ชื่อ Agent">
        <input name="name" required className={inputClass} placeholder="JHCIS-PC-01" />
      </Field>
      <Field label="ความถี่การซิงก์">
        <select name="syncIntervalMinutes" defaultValue="60" className={inputClass}>
          <option value="15">ทุก 15 นาที</option>
          <option value="30">ทุก 30 นาที</option>
          <option value="60">ทุก 1 ชั่วโมง</option>
          <option value="180">ทุก 3 ชั่วโมง</option>
          <option value="720">ทุก 12 ชั่วโมง</option>
          <option value="1440">วันละครั้ง</option>
        </select>
      </Field>
      <div className="flex items-end">
        <Submit label="สร้าง Agent" />
      </div>
    </form>
  );
}

export function AgentTokenForm({
  agentId,
  // The admin area talks to people who know what a token is; the สถานะการนำเข้า
  // page talks to whoever is standing at the รพ.สต. installing the thing.
  label = "ออก token ใหม่",
}: {
  agentId: string;
  label?: string;
}) {
  const [state, action] = useActionState<ActionState, FormData>(reissueEnrollmentTokenAction, {});
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="agentId" value={agentId} />
        <Submit label={label} />
      </form>
      <TokenPanel state={state} />
      {state.error ? <Feedback state={state} /> : null}
    </div>
  );
}

export function AgentRevokeForm({ agentId }: { agentId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(revokeAgentAction, {});
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!confirm("ยืนยันการถอนสิทธิ์ Agent นี้? Agent จะไม่สามารถส่งข้อมูลได้อีก")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="agentId" value={agentId} />
      <Submit label="ถอนสิทธิ์" variant="danger" />
      {state.error ? <Feedback state={state} /> : null}
    </form>
  );
}

export function SyncNowForm({ agentId }: { agentId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(requestSyncAction, {});
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="agentId" value={agentId} />
        <Submit label="สั่งซิงก์เดี๋ยวนี้" />
      </form>
      <Feedback state={state} />
    </div>
  );
}

export function VerifyDataForm({ agentId }: { agentId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(requestVerifyAction, {});
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="agentId" value={agentId} />
        <Submit label="ตรวจสอบความครบถ้วน" />
      </form>
      <Feedback state={state} />
    </div>
  );
}

export function UserForm({
  facilities,
  allowSuperAdmin,
}: {
  facilities: Array<{ id: string; code: string; name: string }>;
  allowSuperAdmin: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(createUserAction, {});
  const [role, setRole] = useState("USER");

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="sm:col-span-2 lg:col-span-3">
        <Feedback state={state} />
      </div>
      <Field label="ชื่อผู้ใช้ (user id)" hint="4-60 ตัว a-z 0-9 . _ -">
        <input name="username" required className={inputClass} placeholder="somchai.j" />
      </Field>
      <Field label="ชื่อ-นามสกุล">
        <input name="fullName" required className={inputClass} />
      </Field>
      <Field label="ตำแหน่ง">
        <input name="position" className={inputClass} placeholder="พยาบาลวิชาชีพ" />
      </Field>
      <Field label="อีเมล">
        <input name="email" type="email" required className={inputClass} />
      </Field>
      <Field label="รหัสผ่านเริ่มต้น" hint="อย่างน้อย 10 ตัวอักษร มีตัวอักษรและตัวเลข">
        <input name="password" type="password" required className={inputClass} />
      </Field>
      <Field label="บทบาท">
        <select
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className={inputClass}
        >
          <option value="USER">ผู้ใช้งาน (เห็นสถานบริการตัวเอง)</option>
          <option value="FACILITY_ADMIN">ผู้ดูแลสถานบริการ</option>
          {allowSuperAdmin ? <option value="ADMIN">แอดมิน (ดูได้ทุกสถานบริการ)</option> : null}
          {allowSuperAdmin ? (
            <option value="SUPER_ADMIN">ผู้ดูแลระบบส่วนกลาง (จัดการได้ทั้งหมด)</option>
          ) : null}
        </select>
      </Field>
      <Field label="สถานบริการ">
        <select
          name="facilityId"
          className={inputClass}
          disabled={role === "SUPER_ADMIN" || role === "ADMIN"}
        >
          <option value="">- ไม่ผูกสถานบริการ -</option>
          {facilities.map((f) => (
            <option key={f.id} value={f.id}>
              {f.code} · {f.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-end">
        <Submit label="สร้างผู้ใช้" />
      </div>
    </form>
  );
}

export function UserToggleForm({
  userId,
  isActive,
  pending = false,
}: {
  userId: string;
  isActive: boolean;
  /** never approved yet - the button reads "อนุมัติ" instead of "เปิดใช้งาน" */
  pending?: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(toggleUserAction, {});
  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="isActive" value={String(!isActive)} />
      <Submit
        label={isActive ? "ปิดใช้งาน" : pending ? "อนุมัติ" : "เปิดใช้งาน"}
        variant={isActive ? "danger" : "primary"}
      />
      {state.error ? <Feedback state={state} /> : null}
    </form>
  );
}
