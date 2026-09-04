"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { issueEnrollmentToken } from "@/lib/agent-auth/enrollment";
import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { requireApiUser } from "@/lib/auth/rbac";
import { canManageFacility, canTriggerSync, isSuperAdmin } from "@/lib/auth/rbac";
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

export async function toggleUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const actor = await requireApiUser();
  const userId = String(formData.get("userId") ?? "");
  const nextActive = String(formData.get("isActive") ?? "") === "true";

  const [target] = await db
    .select({ id: users.id, facilityId: users.facilityId, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target) return fail("ไม่พบผู้ใช้");
  if (target.id === actor.userId) return fail("ไม่สามารถปิดใช้งานบัญชีของตนเองได้");
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
