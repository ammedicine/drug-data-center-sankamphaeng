"use server";

import { and, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { issueEnrollmentToken } from "@/lib/agent-auth/enrollment";
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
import { agentCredentials, agents, facilities, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { clientIp, writeAudit } from "@/lib/services/audit";

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
    .select({ id: agents.id, facilityId: agents.facilityId, name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) return fail("ไม่พบ Agent");
  // Refreshing your own facility's data is not an administrative action.
  if (!canTriggerSync(user, agent.facilityId)) return fail("ไม่มีสิทธิ์สั่งซิงก์ Agent นี้");

  await db.update(agents).set({ syncRequestedAt: new Date() }).where(eq(agents.id, agentId));

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
  return { success: `ส่งคำสั่งซิงก์ไปยัง ${agent.name} แล้ว Agent จะเริ่มภายใน 5 นาที` };
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
