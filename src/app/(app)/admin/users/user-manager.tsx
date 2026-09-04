"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { Button, Field, formatDateTime, inputClass } from "@/components/ui/primitives";

import {
  createUserAction,
  deleteUserAction,
  toggleUserAction,
  updateUserAction,
  type ActionState,
} from "../actions";

export interface ManagedUser {
  id: string;
  username: string | null;
  position: string | null;
  email: string;
  fullName: string;
  role: string;
  facilityId: string | null;
  facilityName: string | null;
  isActive: boolean;
  approvedAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface FacilityOption {
  id: string;
  code: string;
  name: string;
}

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "ผู้ดูแลระบบส่วนกลาง",
  ADMIN: "แอดมิน (ดูทุกสถานบริการ)",
  FACILITY_ADMIN: "ผู้ดูแลสถานบริการ",
  USER: "ผู้ใช้งาน",
};

type Tab = "pending" | "active" | "inactive" | "all";

const TABS: Array<[Tab, string]> = [
  ["pending", "รออนุมัติ"],
  ["active", "ใช้งานอยู่"],
  ["inactive", "ปิดใช้งาน"],
  ["all", "ทั้งหมด"],
];

function statusOf(user: ManagedUser): Tab {
  if (user.isActive) return "active";
  return user.approvedAt ? "inactive" : "pending";
}

function StatusPill({ user }: { user: ManagedUser }) {
  const status = statusOf(user);
  const style =
    status === "active"
      ? "bg-ok-bg text-ok"
      : status === "pending"
        ? "bg-warn-bg text-warn"
        : "bg-[#eef1f4] text-muted";
  const label = status === "active" ? "ใช้งาน" : status === "pending" ? "รออนุมัติ" : "ปิดใช้งาน";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}

function SubmitButton({
  label,
  variant = "primary",
  size = "sm",
}: {
  label: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {pending ? "กำลังบันทึก..." : label}
    </Button>
  );
}

/**
 * Closes a dialog shortly after it succeeds.
 *
 * The form keeps whatever the operator typed, while the table behind it has
 * already been revalidated with the saved values - leaving both on screen shows
 * two versions of the same record, so the dialog steps aside once the
 * confirmation has been readable for a moment.
 */
function useCloseOnSuccess(state: ActionState, onClose: () => void): void {
  useEffect(() => {
    if (!state.success) return;
    const timer = setTimeout(onClose, 1200);
    return () => clearTimeout(timer);
  }, [state.success, onClose]);
}

function Notice({ state }: { state: ActionState }) {
  if (!state.error && !state.success) return null;
  return (
    <p
      role="status"
      className={`rounded-lg px-3 py-2 text-xs ${
        state.error ? "bg-danger-bg text-danger" : "bg-ok-bg text-ok"
      }`}
    >
      {state.error ?? state.success}
    </p>
  );
}

/** Small dialog used for both editing and deleting, so the table stays readable. */
function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-4 py-10"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-xl border border-line bg-surface shadow-lg">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-canvas"
            aria-label="ปิด"
          >
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function UserFormFields({
  user,
  facilities,
  allowDistrictRoles,
}: {
  user?: ManagedUser;
  facilities: FacilityOption[];
  allowDistrictRoles: boolean;
}) {
  const [role, setRole] = useState(user?.role ?? "USER");
  const districtWide = role === "SUPER_ADMIN" || role === "ADMIN";

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="ชื่อ-นามสกุล">
        <input name="fullName" required defaultValue={user?.fullName ?? ""} className={inputClass} />
      </Field>
      <Field label="ตำแหน่ง">
        <input
          name="position"
          defaultValue={user?.position ?? ""}
          placeholder="พยาบาลวิชาชีพ"
          className={inputClass}
        />
      </Field>
      <Field label="ชื่อผู้ใช้ (user id)" hint="4-60 ตัว a-z 0-9 . _ -">
        <input
          name="username"
          defaultValue={user?.username ?? ""}
          placeholder="somchai.j"
          className={inputClass}
        />
      </Field>
      <Field label="อีเมล">
        <input
          name="email"
          type="email"
          required
          defaultValue={user?.email ?? ""}
          className={inputClass}
        />
      </Field>
      <Field label="บทบาท">
        <select
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          className={inputClass}
        >
          <option value="USER">ผู้ใช้งาน (เห็นสถานบริการตัวเอง)</option>
          <option value="FACILITY_ADMIN">ผู้ดูแลสถานบริการ</option>
          {allowDistrictRoles ? <option value="ADMIN">แอดมิน (ดูได้ทุกสถานบริการ)</option> : null}
          {allowDistrictRoles ? (
            <option value="SUPER_ADMIN">ผู้ดูแลระบบส่วนกลาง (จัดการได้ทั้งหมด)</option>
          ) : null}
        </select>
      </Field>
      <Field
        label="สถานบริการ"
        hint={districtWide ? "บทบาทระดับอำเภอไม่ผูกกับสถานบริการ" : undefined}
      >
        <select
          name="facilityId"
          defaultValue={user?.facilityId ?? ""}
          disabled={districtWide}
          className={inputClass}
        >
          <option value="">- เลือกสถานบริการ -</option>
          {facilities.map((facility) => (
            <option key={facility.id} value={facility.id}>
              {facility.code} · {facility.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function EditUserModal({
  user,
  facilities,
  allowDistrictRoles,
  onClose,
}: {
  user: ManagedUser;
  facilities: FacilityOption[];
  allowDistrictRoles: boolean;
  onClose: () => void;
}) {
  const [state, action] = useActionState<ActionState, FormData>(updateUserAction, {});
  useCloseOnSuccess(state, onClose);

  return (
    <Modal
      title={`แก้ไขผู้ใช้ · ${user.fullName}`}
      description={`สร้างเมื่อ ${formatDateTime(user.createdAt)} · เข้าใช้ล่าสุด ${formatDateTime(user.lastLoginAt)}`}
      onClose={onClose}
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="userId" value={user.id} />
        <Notice state={state} />
        <UserFormFields
          key={user.id}
          user={user}
          facilities={facilities}
          allowDistrictRoles={allowDistrictRoles}
        />
        <Field
          label="ตั้งรหัสผ่านใหม่ (เว้นว่างหากไม่เปลี่ยน)"
          hint="อย่างน้อย 10 ตัว มีตัวอักษรและตัวเลข · ผู้ใช้จะถูกบังคับให้เข้าสู่ระบบใหม่"
        >
          <input name="password" type="password" autoComplete="new-password" className={inputClass} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <SubmitButton label="บันทึกการแก้ไข" size="md" />
          <Button variant="secondary" onClick={onClose}>
            ปิด
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteUserModal({ user, onClose }: { user: ManagedUser; onClose: () => void }) {
  const [state, action] = useActionState<ActionState, FormData>(deleteUserAction, {});
  useCloseOnSuccess(state, onClose);
  const expected = user.username || user.email;

  return (
    <Modal
      title={`ลบผู้ใช้ · ${user.fullName}`}
      description="การลบเป็นการลบถาวร ประวัติการใช้งานที่บันทึกไว้จะยังอยู่"
      onClose={onClose}
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="userId" value={user.id} />
        <Notice state={state} />
        <div className="rounded-lg bg-danger-bg px-4 py-3 text-xs text-danger">
          หากต้องการระงับการเข้าใช้ชั่วคราว แนะนำให้กด &ldquo;ปิดใช้งาน&rdquo; แทนการลบ
          เพราะยังตรวจสอบย้อนหลังได้ง่ายกว่า
        </div>
        <Field label={`พิมพ์ "${expected}" เพื่อยืนยัน`}>
          <input name="confirm" required autoComplete="off" className={inputClass} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <SubmitButton label="ลบผู้ใช้ถาวร" variant="danger" size="md" />
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CreateUserPanel({
  facilities,
  allowDistrictRoles,
  onDone,
}: {
  facilities: FacilityOption[];
  allowDistrictRoles: boolean;
  onDone: () => void;
}) {
  const [state, action] = useActionState<ActionState, FormData>(createUserAction, {});
  useCloseOnSuccess(state, onDone);

  return (
    <Modal title="เพิ่มผู้ใช้ใหม่" onClose={onDone}>
      <form action={action} className="space-y-4">
        <Notice state={state} />
        <UserFormFields facilities={facilities} allowDistrictRoles={allowDistrictRoles} />
        <Field label="รหัสผ่านเริ่มต้น" hint="อย่างน้อย 10 ตัว มีตัวอักษรและตัวเลข">
          <input name="password" type="password" required className={inputClass} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <SubmitButton label="สร้างผู้ใช้" size="md" />
          <Button variant="secondary" onClick={onDone}>
            ปิด
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ToggleForm({
  user,
  canApproveRegistration,
}: {
  user: ManagedUser;
  canApproveRegistration: boolean;
}) {
  const [, action] = useActionState<ActionState, FormData>(toggleUserAction, {});
  const pendingApproval = statusOf(user) === "pending";

  // The button is hidden rather than shown-and-rejected, so a facility admin is
  // not invited to press something that will always fail.
  if (pendingApproval && !canApproveRegistration) {
    return <span className="text-xs text-warn">รอส่วนกลางอนุมัติ</span>;
  }

  return (
    <form action={action}>
      <input type="hidden" name="userId" value={user.id} />
      <input type="hidden" name="isActive" value={String(!user.isActive)} />
      <SubmitButton
        label={user.isActive ? "ปิดใช้งาน" : pendingApproval ? "อนุมัติ" : "เปิดใช้งาน"}
        variant={user.isActive ? "secondary" : "primary"}
      />
    </form>
  );
}

/**
 * One screen for the whole account lifecycle: approve, edit, reset a password,
 * disable and delete. Filtering happens in the browser because a district has
 * at most a few hundred accounts, and an admin looking for one person should
 * not wait for a round trip per keystroke.
 */
export function UserManager({
  users,
  facilities,
  allowDistrictRoles,
  canManage,
  canApproveRegistration,
  currentUserId,
}: {
  users: ManagedUser[];
  facilities: FacilityOption[];
  allowDistrictRoles: boolean;
  canManage: boolean;
  /** only a central administrator may let a self-registered account in */
  canApproveRegistration: boolean;
  currentUserId: string;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [facilityFilter, setFacilityFilter] = useState("");
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState<ManagedUser | null>(null);
  const [creating, setCreating] = useState(false);

  const counts = useMemo(
    () => ({
      pending: users.filter((user) => statusOf(user) === "pending").length,
      active: users.filter((user) => statusOf(user) === "active").length,
      inactive: users.filter((user) => statusOf(user) === "inactive").length,
      all: users.length,
    }),
    [users],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users
      .filter((user) => (tab === "all" ? true : statusOf(user) === tab))
      .filter((user) => (roleFilter ? user.role === roleFilter : true))
      .filter((user) => (facilityFilter ? user.facilityId === facilityFilter : true))
      .filter((user) =>
        needle
          ? [user.fullName, user.username ?? "", user.email, user.position ?? ""]
              .join(" ")
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort((a, b) => {
        // pending accounts first: they are the ones waiting on someone
        const order = { pending: 0, active: 1, inactive: 2, all: 3 } as const;
        const diff = order[statusOf(a)] - order[statusOf(b)];
        return diff !== 0 ? diff : a.fullName.localeCompare(b.fullName, "th");
      });
  }, [users, tab, query, roleFilter, facilityFilter]);

  return (
    <div className="rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(16,32,46,0.04)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 pt-4">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === key
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-line text-muted hover:bg-canvas"
            }`}
          >
            {label} ({counts[key]})
            {key === "pending" && counts.pending > 0 ? (
              <span className="ml-1 inline-block size-1.5 rounded-full bg-warn align-middle" />
            ) : null}
          </button>
        ))}

        {canManage ? (
          <div className="ml-auto pb-3">
            <Button onClick={() => setCreating(true)} size="sm">
              + เพิ่มผู้ใช้
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-4">
        <label className="min-w-[220px] flex-1">
          <span className="mb-1.5 block text-xs font-medium text-muted">
            ค้นหา ชื่อ / user id / อีเมล / ตำแหน่ง
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="พิมพ์เพื่อกรองทันที"
            className={inputClass}
            autoComplete="off"
          />
        </label>
        <label>
          <span className="mb-1.5 block text-xs font-medium text-muted">บทบาท</span>
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
            className={inputClass}
          >
            <option value="">ทุกบทบาท</option>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {facilities.length > 1 ? (
          <label>
            <span className="mb-1.5 block text-xs font-medium text-muted">สถานบริการ</span>
            <select
              value={facilityFilter}
              onChange={(event) => setFacilityFilter(event.target.value)}
              className={inputClass}
            >
              <option value="">ทุกสถานบริการ</option>
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.code} · {facility.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="pb-2 text-xs text-muted">แสดง {visible.length} คน</p>
      </div>

      {visible.length === 0 ? (
        <p className="px-5 py-16 text-center text-sm text-muted">ไม่พบผู้ใช้ตามเงื่อนไขที่เลือก</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas/60">
                {["ผู้ใช้", "บทบาท", "สถานบริการ", "สถานะ", "เข้าใช้ล่าสุด", ""].map((header) => (
                  <th
                    key={header}
                    scope="col"
                    className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => {
                const isSelf = user.id === currentUserId;
                return (
                  <tr
                    key={user.id}
                    className="border-b border-line/70 last:border-0 hover:bg-canvas/60"
                  >
                    <td className="px-4 py-3">
                      <span className="font-medium text-ink">
                        {user.fullName}
                        {isSelf ? (
                          <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-xs font-normal text-brand-700">
                            บัญชีของคุณ
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-xs text-muted">
                        {user.username ? `${user.username} · ` : ""}
                        {user.position ?? user.email}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">{ROLE_LABELS[user.role] ?? user.role}</td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {user.facilityName ?? "ทุกสถานบริการ"}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill user={user} />
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {formatDateTime(user.lastLoginAt)}
                    </td>
                    <td className="px-4 py-3">
                      {canManage && !isSelf ? (
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <ToggleForm
                            user={user}
                            canApproveRegistration={canApproveRegistration}
                          />
                          <Button variant="secondary" size="sm" onClick={() => setEditing(user)}>
                            แก้ไข
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setDeleting(user)}>
                            ลบ
                          </Button>
                        </div>
                      ) : (
                        <span className="block text-right text-xs text-muted">
                          {isSelf ? "แก้ไขบัญชีตนเองที่นี่ไม่ได้" : "ดูอย่างเดียว"}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <EditUserModal
          user={editing}
          facilities={facilities}
          allowDistrictRoles={allowDistrictRoles}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteUserModal user={deleting} onClose={() => setDeleting(null)} />
      ) : null}
      {creating ? (
        <CreateUserPanel
          facilities={facilities}
          allowDistrictRoles={allowDistrictRoles}
          onDone={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}
