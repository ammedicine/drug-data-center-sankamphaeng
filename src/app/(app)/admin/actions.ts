"use server";

import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { issueEnrollmentToken } from "@/lib/agent-auth/enrollment";
import { effectiveStatus, listRunningBatches } from "@/lib/services/monitoring";
import {
  changeAgentSyncControl,
  resolveAgentIds,
  SyncControlAuthorizationError,
} from "@/lib/services/fleet";
import { countFacilityUsage, purgeFacilityUsage } from "@/lib/services/sync";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { requireApiUser } from "@/lib/auth/rbac";
import {
  canApproveRegistration,
  canManageFacility,
  canManageUsers,
  canTriggerSync,
  isSuperAdmin,
} from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import {
  agentCredentials,
  agentEnrollmentTokens,
  agents,
  facilities,
  users,
} from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { clientIp, writeAudit } from "@/lib/services/audit";
import {
  cancelUpdateCommand,
  NoInstallableReleaseError,
  requestAgentUpdates,
  UpdateAuthorizationError,
} from "@/lib/services/update-commands";

export interface ActionState {
  error?: string;
  success?: string;
  /** shown once after creating an agent - the operator must copy it */
  enrollmentToken?: string;
  enrollmentExpiresAt?: string;
}

function fail(message: string): ActionState {
  return { error: message };
}

/* ------------------------------------------------------------- facilities */

export async function createFacilityAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  if (!isSuperAdmin(user)) return fail("เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้น");

  const code = String(formData.get("code") ?? "").trim();
  const pcucode = String(formData.get("jhcisPcucode") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  if (!code || !name) return fail("กรุณากรอกรหัสและชื่อสถานบริการ");
  if (!/^\d{5}$/.test(pcucode)) return fail("รหัส pcucode ของ JHCIS ต้องเป็นตัวเลข 5 หลัก");

  const facilityId = newId();
  try {
    await db.insert(facilities).values({
      id: facilityId,
      code,
      jhcisPcucode: pcucode,
      name,
      province: String(formData.get("province") ?? "").trim() || null,
      district: String(formData.get("district") ?? "").trim() || null,
      subdistrict: String(formData.get("subdistrict") ?? "").trim() || null,
    });
  } catch {
    return fail("รหัสสถานบริการหรือ pcucode นี้ถูกใช้แล้ว");
  }

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "FACILITY_CREATE",
    resource: "facility",
    resourceId: facilityId,
    facilityId,
    ip: clientIp(await headers()),
    metadata: { code, pcucode },
  });

  revalidatePath("/admin/facilities");
  return { success: `เพิ่มสถานบริการ ${name} เรียบร้อย` };
}

export async function toggleFacilityAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  if (!isSuperAdmin(user)) return fail("เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้น");

  const facilityId = String(formData.get("facilityId") ?? "");
  const nextActive = String(formData.get("isActive") ?? "") === "true";

  await db.update(facilities).set({ isActive: nextActive }).where(eq(facilities.id, facilityId));

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: nextActive ? "FACILITY_UPDATE" : "FACILITY_DISABLE",
    resource: "facility",
    resourceId: facilityId,
    facilityId,
    ip: clientIp(await headers()),
  });

  revalidatePath("/admin/facilities");
  return { success: nextActive ? "เปิดใช้งานสถานบริการแล้ว" : "ปิดใช้งานสถานบริการแล้ว" };
}

/* ----------------------------------------------------------------- agents */

export async function createAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  const facilityId = String(formData.get("facilityId") ?? "");
  if (!canManageFacility(user, facilityId)) return fail("ไม่มีสิทธิ์สร้าง Agent ของสถานบริการนี้");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return fail("กรุณาระบุชื่อ Agent");

  const syncInterval = Number(formData.get("syncIntervalMinutes") ?? 60);
  if (![15, 30, 60, 180, 720, 1440].includes(syncInterval)) {
    return fail("ช่วงเวลาการซิงก์ไม่ถูกต้อง");
  }

  const agentId = newId();
  await db.insert(agents).values({
    id: agentId,
    facilityId,
    name,
    syncIntervalMinutes: syncInterval,
    status: "OFFLINE",
  });

  const token = await issueEnrollmentToken({
    agentId,
    facilityId,
    createdByUserId: user.userId,
  });

  const ip = clientIp(await headers());
  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "AGENT_CREATE",
    resource: "agent",
    resourceId: agentId,
    facilityId,
    ip,
    metadata: { name, syncInterval },
  });

  revalidatePath("/admin/agents");
  return {
    success: `สร้าง Agent "${name}" แล้ว คัดลอก enrollment token ไปใช้ตอนติดตั้ง`,
    enrollmentToken: token.token,
    enrollmentExpiresAt: token.expiresAt.toISOString(),
  };
}

export async function reissueEnrollmentTokenAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  const agentId = String(formData.get("agentId") ?? "");

  const [agent] = await db
    .select({ id: agents.id, facilityId: agents.facilityId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return fail("ไม่พบ Agent");
  if (!canManageFacility(user, agent.facilityId)) return fail("ไม่มีสิทธิ์จัดการ Agent นี้");

  const token = await issueEnrollmentToken({
    agentId,
    facilityId: agent.facilityId,
    createdByUserId: user.userId,
  });

  // Whoever enrols a machine owns it, and it is named after their user id -
  // a สถานบริการ with several PCs then reads as a list of people rather than a
  // list of hostnames nobody recognises. A SUPER_ADMIN issuing a code on
  // someone else's behalf does not take the agent from them.
  if (user.role !== "SUPER_ADMIN") {
    // The user id is not carried in the session token, so read it here rather
    // than widening the token and forcing everyone to sign in again.
    const [account] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, user.userId))
      .limit(1);
    await db
      .update(agents)
      .set({
        ownerUserId: user.userId,
        ...(account?.username ? { name: account.username } : {}),
      })
      .where(eq(agents.id, agentId));
  }

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "AGENT_TOKEN_ISSUE",
    resource: "agent",
    resourceId: agentId,
    facilityId: agent.facilityId,
    ip: clientIp(await headers()),
  });

  revalidatePath("/admin/agents");
  return {
    success: `ออก enrollment token ใหม่สำหรับ ${agent.name}`,
    enrollmentToken: token.token,
    enrollmentExpiresAt: token.expiresAt.toISOString(),
  };
}

export async function revokeAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  const agentId = String(formData.get("agentId") ?? "");

  const [agent] = await db
    .select({ id: agents.id, facilityId: agents.facilityId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return fail("ไม่พบ Agent");
  if (!canManageFacility(user, agent.facilityId)) return fail("ไม่มีสิทธิ์จัดการ Agent นี้");

  const now = new Date();
  await db
    .update(agentCredentials)
    .set({ isActive: false, revokedAt: now })
    .where(eq(agentCredentials.agentId, agentId));
  await db.update(agents).set({ status: "DISABLED", revokedAt: now }).where(eq(agents.id, agentId));

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "AGENT_REVOKE",
    resource: "agent",
    resourceId: agentId,
    facilityId: agent.facilityId,
    ip: clientIp(await headers()),
  });

  revalidatePath("/admin/agents");
  return { success: `ถอนสิทธิ์ Agent ${agent.name} แล้ว` };
}

/**
 * "Sync Now" (PROJECT_SPEC section 13).
 * The central server cannot reach into a รพ.สต. LAN, so this raises a flag that
 * the agent reads on its next heartbeat (within 5 minutes) and acts on.
 */
export async function requestSyncAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  const agentId = String(formData.get("agentId") ?? "");
  const [agent] = await db
    .select({
      id: agents.id,
      facilityId: agents.facilityId,
      name: agents.name,
      status: agents.status,
      lastHeartbeatAt: agents.lastHeartbeatAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return fail("ไม่พบ Agent");
  // Refreshing your own facility's data is not an administrative action.
  if (!canTriggerSync(user, agent.facilityId)) return fail("ไม่มีสิทธิ์สั่งซิงก์ Agent นี้");

  const state = effectiveStatus(agent);
  if (state === "DISABLED") {
    return fail(`${agent.name} ถูกปิดใช้งานอยู่ จึงสั่งซิงก์ไม่ได้`);
  }

  // Two machines pulling the same สถานบริการ at once is not harmful - the
  // record key makes every row idempotent - but it doubles the load on one
  // JHCIS server and leaves whoever asked wondering why it is slow. Say who is
  // already doing it rather than silently starting a second run.
  const running = await listRunningBatches([agent.facilityId]);
  const other = running.find((batch) => batch.agentId !== agentId);
  if (other) {
    return fail(
      `สถานบริการของท่านกำลังดึงข้อมูลอยู่แล้ว โดย ${other.ownerName ?? other.agentName} ` +
        `(คืบหน้า ${Math.round(other.progress * 100)}%) กรุณารอให้เสร็จก่อนแล้วค่อยสั่งใหม่`,
    );
  }

  // An explicit window re-reads that period whatever the agent thinks it has
  // already delivered; without one it simply resumes from the watermark.
  const from = String(formData.get("from") ?? "").trim() || null;
  const to = String(formData.get("to") ?? "").trim() || null;
  if ((from && !to) || (to && !from)) {
    return fail("เลือกช่วงวันที่ต้องระบุทั้งวันเริ่มและวันสิ้นสุด");
  }
  if (from && to && from > to) return fail("วันเริ่มต้องไม่เกินวันสิ้นสุด");

  await db
    .update(agents)
    .set({ syncRequestedAt: new Date(), syncRequestedFrom: from, syncRequestedTo: to })
    .where(eq(agents.id, agentId));

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "SYNC_START",
    resource: "agent",
    resourceId: agentId,
    facilityId: agent.facilityId,
    ip: clientIp(await headers()),
    metadata: { trigger: "manual" },
  });

  revalidatePath("/admin/agents");
  revalidatePath("/sync");
  // The central server cannot push into a รพ.สต. LAN, so this is a flag the
  // agent picks up on its next heartbeat. Promising "within 5 minutes" when
  // the agent has not called home for hours is simply untrue: the request is
  // still recorded and will run when it comes back, and that is what to say.
  const window = from ? ` เฉพาะวันที่รับบริการ ${from} ถึง ${to}` : "";
  if (state === "ONLINE") {
    return {
      success: `ส่งคำสั่งซิงก์ไปยัง ${agent.name} แล้ว${window} Agent จะเริ่มภายใน 5 นาที`,
    };
  }

  const lastSeen = agent.lastHeartbeatAt
    ? `ติดต่อครั้งล่าสุด ${agent.lastHeartbeatAt.toLocaleString("th-TH")}`
    : "ยังไม่เคยติดต่อเข้ามาเลย";
  return {
    success:
      `บันทึกคำสั่งซิงก์ไว้แล้ว${window} แต่ ${agent.name} ยังออฟไลน์ (${lastSeen}) ` +
      `จะเริ่มทำงานทันทีที่โปรแกรมกลับมาออนไลน์ - ตรวจว่าเครื่องที่ รพ.สต. เปิดอยู่และโปรแกรมทำงานอยู่ในถาดระบบ`,
  };
}

/**
 * "ตรวจสอบและซ่อมข้อมูล": asks the agent to compare every month against JHCIS
 * and re-send whatever the central database is missing. Same delivery route as
 * Sync Now - a flag the agent reads on its next heartbeat.
 */
export async function requestVerifyAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  const agentId = String(formData.get("agentId") ?? "");

  const [agent] = await db
    .select({ id: agents.id, facilityId: agents.facilityId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return fail("ไม่พบ Agent");
  if (!canTriggerSync(user, agent.facilityId)) return fail("ไม่มีสิทธิ์สั่งตรวจสอบข้อมูล");

  await db.update(agents).set({ verifyRequestedAt: new Date() }).where(eq(agents.id, agentId));

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "SYNC_START",
    resource: "agent",
    resourceId: agentId,
    facilityId: agent.facilityId,
    ip: clientIp(await headers()),
    metadata: { trigger: "verify" },
  });

  revalidatePath("/sync");
  revalidatePath("/admin/agents");
  return {
    success: `ส่งคำสั่งตรวจสอบความครบถ้วนไปยัง ${agent.name} แล้ว ระบบจะเทียบข้อมูลรายเดือนกับ JHCIS และส่งส่วนที่ขาดเพิ่ม`,
  };
}

/* ------------------------------------------------------------------ users */

export async function createUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireApiUser();

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const username = String(formData.get("username") ?? "")
    .trim()
    .toLowerCase();
  const position = String(formData.get("position") ?? "").trim() || null;
  const fullName = String(formData.get("fullName") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "USER");
  const facilityId = String(formData.get("facilityId") ?? "") || null;

  if (!email || !fullName) return fail("กรุณากรอกอีเมลและชื่อ-นามสกุล");
  if (username && !/^[a-z0-9._-]{4,60}$/.test(username)) {
    return fail("ชื่อผู้ใช้ต้องยาว 4-60 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -");
  }
  const weak = validatePasswordStrength(password);
  if (weak) return fail(weak);

  // A FACILITY_ADMIN may only create users inside its own facility, and may
  // never create a SUPER_ADMIN (privilege escalation guard).
  if (!isSuperAdmin(actor)) {
    if (role === "SUPER_ADMIN" || role === "ADMIN") {
      return fail("ไม่มีสิทธิ์สร้างผู้ดูแลระดับอำเภอ");
    }
    if (!facilityId || facilityId !== actor.facilityId) {
      return fail("สร้างผู้ใช้ได้เฉพาะในสถานบริการของตนเอง");
    }
  }
  const facilityWide = role === "SUPER_ADMIN" || role === "ADMIN";
  if (!facilityWide && !facilityId) return fail("กรุณาเลือกสถานบริการ");

  const userId = newId();
  try {
    await db.insert(users).values({
      id: userId,
      email,
      username: username || null,
      position,
      fullName,
      passwordHash: await hashPassword(password),
      role: role as "SUPER_ADMIN" | "ADMIN" | "FACILITY_ADMIN" | "USER",
      // created by an admin, so it is approved on the spot
      facilityId: role === "SUPER_ADMIN" || role === "ADMIN" ? null : facilityId,
      approvedAt: new Date(),
      approvedByUserId: actor.userId,
    });
  } catch {
    return fail("อีเมลนี้ถูกใช้งานแล้ว");
  }

  await writeAudit({
    actorType: "USER",
    actorId: actor.userId,
    actorLabel: actor.email,
    action: "USER_CREATE",
    resource: "user",
    resourceId: userId,
    facilityId,
    ip: clientIp(await headers()),
    metadata: { email, role },
  });

  revalidatePath("/admin/users");
  return { success: `สร้างผู้ใช้ ${email} เรียบร้อย` };
}

/**
 * Shared guard for acting on another account.
 *
 * A FACILITY_ADMIN manages only its own facility and never a district-wide
 * role; nobody edits their own row through this path, because the dangerous
 * fields (role, facility, active) would let an account widen its own access.
 */
async function loadManageableUser(
  actor: Awaited<ReturnType<typeof requireApiUser>>,
  userId: string,
  options: { allowSelf?: boolean } = {},
) {
  const [target] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      fullName: users.fullName,
      position: users.position,
      role: users.role,
      facilityId: users.facilityId,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!target) return { ok: false, error: "ไม่พบผู้ใช้" } as const;
  if (!options.allowSelf && target.id === actor.userId) {
    return { ok: false, error: "ไม่สามารถแก้ไขบัญชีของตนเองจากหน้านี้" } as const;
  }
  if (!isSuperAdmin(actor)) {
    if (
      target.role === "SUPER_ADMIN" ||
      target.role === "ADMIN" ||
      target.facilityId !== actor.facilityId
    ) {
      return { ok: false, error: "ไม่มีสิทธิ์จัดการผู้ใช้รายนี้" } as const;
    }
  }
  return { ok: true, target } as const;
}

/** Edits an existing account, optionally setting a new password. */
export async function updateUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireApiUser();
  if (!canManageUsers(actor)) return fail("ไม่มีสิทธิ์จัดการผู้ใช้");

  const userId = String(formData.get("userId") ?? "");
  const found = await loadManageableUser(actor, userId);
  if (!found.ok) return fail(found.error);
  const target = found.target;

  const fullName = String(formData.get("fullName") ?? "").trim();
  const position = String(formData.get("position") ?? "").trim() || null;
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const username = String(formData.get("username") ?? "")
    .trim()
    .toLowerCase();
  const role = String(formData.get("role") ?? target.role);
  const facilityId = String(formData.get("facilityId") ?? "") || null;
  const password = String(formData.get("password") ?? "");

  if (!fullName) return fail("กรุณากรอกชื่อ-นามสกุล");
  if (!email) return fail("กรุณากรอกอีเมล");
  if (username && !/^[a-z0-9._-]{4,60}$/.test(username)) {
    return fail("ชื่อผู้ใช้ต้องยาว 4-60 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -");
  }

  const districtWide = role === "SUPER_ADMIN" || role === "ADMIN";
  if (!isSuperAdmin(actor)) {
    if (districtWide) return fail("ไม่มีสิทธิ์ตั้งบทบาทระดับอำเภอ");
    if (facilityId !== actor.facilityId) return fail("ย้ายผู้ใช้ออกนอกสถานบริการของตนไม่ได้");
  }
  if (!districtWide && !facilityId) return fail("กรุณาเลือกสถานบริการ");

  // Demoting the last super admin would lock everyone out of administration.
  if (target.role === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
    const [{ remaining }] = await db
      .select({ remaining: sql<number>`COUNT(*)` })
      .from(users)
      .where(and(eq(users.role, "SUPER_ADMIN"), eq(users.isActive, true)));
    if (Number(remaining) <= 1) return fail("ต้องมีผู้ดูแลระบบส่วนกลางอย่างน้อย 1 คน");
  }

  let passwordHash: string | undefined;
  if (password) {
    const weak = validatePasswordStrength(password);
    if (weak) return fail(weak);
    passwordHash = await hashPassword(password);
  }

  try {
    await db
      .update(users)
      .set({
        fullName,
        position,
        email,
        username: username || null,
        role: role as "SUPER_ADMIN" | "ADMIN" | "FACILITY_ADMIN" | "USER",
        facilityId: districtWide ? null : facilityId,
        ...(passwordHash
          ? // a new password must invalidate sessions issued with the old one
            { passwordHash, sessionEpoch: Date.now() % 1_000_000 }
          : {}),
      })
      .where(eq(users.id, userId));
  } catch {
    return fail("อีเมลหรือชื่อผู้ใช้นี้ถูกใช้แล้ว");
  }

  const ip = clientIp(await headers());
  await writeAudit({
    actorType: "USER",
    actorId: actor.userId,
    actorLabel: actor.email,
    action: "USER_UPDATE",
    resource: "user",
    resourceId: userId,
    facilityId: districtWide ? null : facilityId,
    ip,
    metadata: { email, role, renamed: fullName !== target.fullName },
  });
  if (passwordHash) {
    await writeAudit({
      actorType: "USER",
      actorId: actor.userId,
      actorLabel: actor.email,
      action: "USER_PASSWORD_RESET",
      resource: "user",
      resourceId: userId,
      facilityId: districtWide ? null : facilityId,
      ip,
    });
  }

  revalidatePath("/admin/users");
  return {
    success: passwordHash
      ? `บันทึกข้อมูล ${fullName} และตั้งรหัสผ่านใหม่แล้ว (ผู้ใช้ต้องเข้าสู่ระบบใหม่)`
      : `บันทึกข้อมูล ${fullName} เรียบร้อย`,
  };
}

/** Removes an account for good. Requires typing the username to confirm. */
export async function deleteUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireApiUser();
  if (!canManageUsers(actor)) return fail("ไม่มีสิทธิ์จัดการผู้ใช้");

  const userId = String(formData.get("userId") ?? "");
  const confirmation = String(formData.get("confirm") ?? "").trim();

  const found = await loadManageableUser(actor, userId);
  if (!found.ok) return fail(found.error);
  const target = found.target;

  const expected = target.username || target.email;
  if (confirmation !== expected) {
    return fail(`พิมพ์ "${expected}" เพื่อยืนยันการลบ`);
  }

  if (target.role === "SUPER_ADMIN") {
    const [{ remaining }] = await db
      .select({ remaining: sql<number>`COUNT(*)` })
      .from(users)
      .where(eq(users.role, "SUPER_ADMIN"));
    if (Number(remaining) <= 1) return fail("ลบผู้ดูแลระบบส่วนกลางคนสุดท้ายไม่ได้");
  }

  await db.delete(users).where(eq(users.id, userId));

  await writeAudit({
    actorType: "USER",
    actorId: actor.userId,
    actorLabel: actor.email,
    action: "USER_DELETE",
    resource: "user",
    resourceId: userId,
    facilityId: target.facilityId,
    ip: clientIp(await headers()),
    // keep who was removed: the row itself is gone from users
    metadata: { email: target.email, username: target.username, role: target.role },
  });

  revalidatePath("/admin/users");
  return { success: `ลบผู้ใช้ ${expected} แล้ว` };
}

export async function toggleUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireApiUser();
  const userId = String(formData.get("userId") ?? "");
  const nextActive = String(formData.get("isActive") ?? "") === "true";

  const [target] = await db
    .select({
      id: users.id,
      facilityId: users.facilityId,
      email: users.email,
      role: users.role,
      approvedAt: users.approvedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return fail("ไม่พบผู้ใช้");
  if (target.id === actor.userId) return fail("ไม่สามารถปิดใช้งานบัญชีของตนเองได้");

  // A self-registered account has never been approved by anyone; letting it in
  // is a central decision, because the applicant chose which facility to claim.
  if (nextActive && !target.approvedAt && !canApproveRegistration(actor)) {
    return fail("บัญชีที่สมัครเข้ามาเอง ต้องให้ผู้ดูแลระบบส่วนกลางเป็นผู้อนุมัติ");
  }
  if (!isSuperAdmin(actor)) {
    if (
      target.role === "SUPER_ADMIN" ||
      target.role === "ADMIN" ||
      target.facilityId !== actor.facilityId
    ) {
      return fail("ไม่มีสิทธิ์จัดการผู้ใช้รายนี้");
    }
  }

  await db
    .update(users)
    .set({
      isActive: nextActive,
      // bumping the epoch invalidates any session token already issued
      sessionEpoch: nextActive ? undefined : Date.now() % 1_000_000,
      ...(nextActive ? { approvedAt: new Date(), approvedByUserId: actor.userId } : {}),
    })
    .where(eq(users.id, userId));

  await writeAudit({
    actorType: "USER",
    actorId: actor.userId,
    actorLabel: actor.email,
    action: nextActive ? "USER_UPDATE" : "USER_DISABLE",
    resource: "user",
    resourceId: userId,
    facilityId: target.facilityId,
    ip: clientIp(await headers()),
  });

  revalidatePath("/admin/users");
  return { success: nextActive ? "เปิดใช้งานผู้ใช้แล้ว" : "ปิดใช้งานผู้ใช้แล้ว" };
}

/**
 * Deletes a สถานบริการ's dispensing records - everything, or one range of
 * service dates.
 *
 * Destructive and irreversible from the web, so it is gated three ways: only a
 * SUPER_ADMIN may call it, the facility's own code must be typed to confirm
 * (a mis-click cannot reach it, and the code names which facility is being
 * emptied), and the outcome is written to the audit log with the range and the
 * number of rows removed. The data can be brought back by syncing again -
 * purgeFacilityUsage rewinds the agent watermark so the next run re-reads the
 * window rather than believing it is already delivered.
 */
export async function purgeFacilityDataAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  if (!isSuperAdmin(user)) return fail("เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้น");

  const facilityId = String(formData.get("facilityId") ?? "");
  const scope = String(formData.get("scope") ?? "range");
  const confirm = String(formData.get("confirm") ?? "").trim();

  const [facility] = await db
    .select({ id: facilities.id, code: facilities.code, name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, facilityId))
    .limit(1);
  if (!facility) return fail("ไม่พบสถานบริการ");

  if (confirm !== facility.code) {
    return fail(`กรุณาพิมพ์รหัสสถานบริการ "${facility.code}" ให้ตรงเพื่อยืนยัน`);
  }

  let from: string | null = null;
  let to: string | null = null;
  if (scope === "range") {
    from = String(formData.get("from") ?? "").trim() || null;
    to = String(formData.get("to") ?? "").trim() || null;
    if (!from || !to) return fail("กรุณาเลือกช่วงวันที่รับบริการให้ครบทั้งวันเริ่มและวันสิ้นสุด");
    if (from > to) return fail("วันเริ่มต้องไม่เกินวันสิ้นสุด");
  }

  const request = { facilityId, from, to };
  const expected = await countFacilityUsage(request);
  if (expected === 0) {
    return fail("ไม่มีข้อมูลในเงื่อนไขที่เลือก จึงไม่มีอะไรให้ล้าง");
  }

  const result = await purgeFacilityUsage(request);

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "FACILITY_DATA_PURGE",
    resource: "drug_usage",
    resourceId: facilityId,
    facilityId,
    ip: clientIp(await headers()),
    metadata: { from, to, deletedRows: result.deletedRows, watermark: result.watermarkResetTo },
  });

  revalidatePath("/admin/facilities");
  revalidatePath("/dashboard");

  const window = from ? `ช่วง ${from} ถึง ${to}` : "ทั้งหมด";
  const rerun = result.watermarkResetTo
    ? `Agent จะดึงข้อมูลตั้งแต่ ${result.watermarkResetTo} ใหม่ในรอบถัดไป`
    : "Agent จะดึงข้อมูลใหม่ทั้งหมดในรอบถัดไป";
  return {
    success: `ล้างข้อมูล ${facility.name} ${window} แล้ว ${formatCount(result.deletedRows)} รายการ · ${rerun}`,
  };
}

function formatCount(value: number): string {
  return value.toLocaleString("th-TH");
}

/**
 * Removes an Agent from the system entirely.
 *
 * Different from revoking: revoking leaves the row disabled and visible, this
 * deletes it. The credential goes with it, so the copy installed at the
 * รพ.สต. stops being able to speak to Central at all - its next request is
 * rejected as an unknown credential, and getting that machine working again
 * means enrolling it afresh with a new code.
 *
 * The dispensing data it delivered is NOT touched - that belongs to the
 * สถานบริการ, not to the machine that carried it - and neither is the batch
 * history, which is the record of what happened and now reads "Agent ที่ถูกลบแล้ว"
 * where the name used to be.
 */
export async function deleteAgentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  if (!isSuperAdmin(user)) return fail("เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้นที่ลบ Agent ได้");

  const agentId = String(formData.get("agentId") ?? "");
  const [agent] = await db
    .select({ id: agents.id, facilityId: agents.facilityId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return fail("ไม่พบ Agent");

  await db.delete(agentCredentials).where(eq(agentCredentials.agentId, agentId));
  await db.delete(agentEnrollmentTokens).where(eq(agentEnrollmentTokens.agentId, agentId));
  await db.delete(agents).where(eq(agents.id, agentId));

  await writeAudit({
    actorType: "USER",
    actorId: user.userId,
    actorLabel: user.email,
    action: "AGENT_DELETE",
    resource: "agent",
    resourceId: agentId,
    facilityId: agent.facilityId,
    ip: clientIp(await headers()),
    metadata: { name: agent.name },
  });

  revalidatePath("/admin/agents");
  revalidatePath("/sync");
  return {
    success: `ลบ ${agent.name} ออกจากระบบแล้ว เครื่องที่ติดตั้งไว้จะใช้งานไม่ได้จนกว่าจะลงทะเบียนใหม่ (ข้อมูลการจ่ายยาที่เคยส่งมายังอยู่ครบ)`,
  };
}

/* ------------------------------------------------- remote sync control */

/**
 * Stops or starts an agent's data sync from the centre.
 *
 * SUPER_ADMIN only, and checked here rather than by hiding a button: a
 * FACILITY_ADMIN who crafts the request by hand must be refused too, and the
 * only place that can be guaranteed is the server.
 *
 * This never kills anything. The agent stays enrolled, keeps authenticating,
 * keeps heartbeating and keeps taking updates - it simply stops being allowed
 * to write dispensing data, and Central stops accepting it whether the agent
 * has understood the instruction or not.
 */
async function applySyncControl(
  agentIds: string[],
  desired: "RUNNING" | "PAUSED",
  reason: string | null,
): Promise<ActionState> {
  const user = await requireApiUser();
  // Checked here as well as in the service, so an unauthorised request is
  // refused with a sentence a person can read rather than an exception.
  if (!isSuperAdmin(user)) return fail("เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้นที่สั่งหยุด/เปิดการซิงก์ได้");
  if (!agentIds.length) return fail("ยังไม่ได้เลือก Agent");

  const ip = clientIp(await headers());

  // One call, one transaction per agent, one audit row per real transition.
  // There is no separate audit step to forget.
  let outcomes;
  try {
    outcomes = await changeAgentSyncControl({
      agentIds,
      desired,
      reason,
      actor: { userId: user.userId, label: user.email, ip },
    });
  } catch (error) {
    if (error instanceof SyncControlAuthorizationError) return fail(error.message);
    throw error;
  }

  const changed = outcomes.filter((o) => o.changed).length;

  revalidatePath("/admin/agents");
  revalidatePath("/admin/monitoring");
  revalidatePath("/admin/fleet");
  revalidatePath("/sync");

  if (!changed) {
    return {
      success:
        desired === "PAUSED" ? "Agent ที่เลือกหยุดการซิงก์อยู่แล้ว" : "Agent ที่เลือกทำงานอยู่แล้ว",
    };
  }
  return {
    success:
      desired === "PAUSED"
        ? `หยุดการซิงก์ ${changed} Agent แล้ว ศูนย์กลางจะไม่รับข้อมูลใหม่จากเครื่องเหล่านี้ทันที`
        : `เปิดการซิงก์ ${changed} Agent แล้ว`,
  };
}

export async function pauseAgentSyncAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const ids = await resolveSelection(formData);
  return applySyncControl(ids, "PAUSED", reason);
}

export async function resumeAgentSyncAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ids = await resolveSelection(formData);
  return applySyncControl(ids, "RUNNING", null);
}

/* ------------------------------------------------ remote software update */

/**
 * "Update now", for one Agent or the selection.
 *
 * SUPER_ADMIN only - checked here for a readable refusal, and again inside
 * requestAgentUpdates by re-reading the user from the database, because a
 * session says what somebody was when they signed in. One durable command
 * per Agent; the outcomes are summarised in plain Thai so an operator can see
 * at once which machines will update, which already had, and which cannot.
 */
export async function requestAgentUpdateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  if (!isSuperAdmin(user)) return fail("เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้นที่สั่งอัปเดต Agent ได้");
  const agentIds = await resolveSelection(formData);
  if (!agentIds.length) return fail("ยังไม่ได้เลือก Agent");

  const ip = clientIp(await headers());
  let result;
  try {
    result = await requestAgentUpdates({ agentIds, actor: { userId: user.userId, label: user.email, ip } });
  } catch (error) {
    if (error instanceof UpdateAuthorizationError || error instanceof NoInstallableReleaseError) {
      return fail(error.message);
    }
    throw error;
  }

  revalidatePath("/admin/fleet");
  revalidatePath("/admin/agents");

  const count = (k: string) => result.outcomes.filter((o) => o.outcome === k).length;
  const parts: string[] = [];
  if (count("REQUESTED")) parts.push(`สั่งอัปเดตเป็นรุ่น ${result.target.version} ให้ ${count("REQUESTED")} Agent แล้ว`);
  if (count("DUPLICATE")) parts.push(`${count("DUPLICATE")} Agent มีคำสั่งอัปเดตค้างอยู่แล้ว`);
  if (count("ALREADY_UP_TO_DATE")) parts.push(`${count("ALREADY_UP_TO_DATE")} Agent เป็นรุ่นล่าสุดแล้ว`);
  if (count("UNSUPPORTED_CLIENT")) {
    parts.push(
      `${count("UNSUPPORTED_CLIENT")} Agent เป็นรุ่นเก่าที่ยังไม่รองรับคำสั่งจากศูนย์กลาง (จะอัปเดตเองตามรอบ หรือต้องติดตั้งด้วยมืออีกครั้ง)`,
    );
  }
  if (count("NOT_FOUND")) parts.push(`${count("NOT_FOUND")} Agent ไม่พบในระบบ`);
  return { success: parts.join(" · ") || "ไม่มีอะไรเปลี่ยนแปลง" };
}

/** Withdraws a command an Agent has not picked up yet. */
export async function cancelAgentUpdateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireApiUser();
  if (!isSuperAdmin(user)) return fail("เฉพาะผู้ดูแลระบบส่วนกลางเท่านั้นที่ยกเลิกคำสั่งอัปเดตได้");
  const commandId = String(formData.get("commandId") ?? "").trim();
  if (!commandId) return fail("ไม่พบคำสั่ง");
  const ip = clientIp(await headers());
  let ok = false;
  try {
    ok = await cancelUpdateCommand({ commandId, actor: { userId: user.userId, label: user.email, ip } });
  } catch (error) {
    if (error instanceof UpdateAuthorizationError) return fail(error.message);
    throw error;
  }
  revalidatePath("/admin/fleet");
  return ok ? { success: "ยกเลิกคำสั่งอัปเดตแล้ว" } : fail("ยกเลิกไม่ได้ Agent รับคำสั่งไปแล้ว");
}

/**
 * Which agents an action applies to, decided on the server.
 *
 * "All" is resolved from the database rather than from a list the browser
 * sent, so a stale page cannot quietly miss the สถานบริการ that was enrolled
 * five minutes ago - which during a reset is precisely the one that would
 * refill Central.
 */
async function resolveSelection(formData: FormData): Promise<string[]> {
  const scope = String(formData.get("scope") ?? "selected");
  if (scope === "all") return resolveAgentIds({ all: true });
  const agentIds = formData.getAll("agentId").map(String).filter(Boolean);
  const facilityIds = formData.getAll("facilityId").map(String).filter(Boolean);
  return resolveAgentIds({ agentIds, facilityIds });
}
