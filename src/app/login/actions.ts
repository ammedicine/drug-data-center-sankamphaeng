"use server";

import { eq, or } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { verifyPassword } from "@/lib/auth/password";
import { clearSessionCookie, setSessionCookie } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { clientIp, writeAudit } from "@/lib/services/audit";

export interface LoginState {
  error?: string;
}

/**
 * Password login by user id (or email, for the accounts seeded before
 * registration existed). The same generic message is returned for unknown
 * accounts and wrong passwords so the form cannot be used to enumerate users;
 * the one exception is an account that exists and authenticated correctly but
 * is still awaiting approval - that person needs to know why they are blocked.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const identifier = String(formData.get("identifier") ?? formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const ip = clientIp(await headers());

  if (!identifier || !password) {
    return { error: "กรุณากรอกชื่อผู้ใช้และรหัสผ่าน" };
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      facilityId: users.facilityId,
      username: users.username,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
      sessionEpoch: users.sessionEpoch,
    })
    .from(users)
    .where(or(eq(users.username, identifier), eq(users.email, identifier)))
    .limit(1);

  const ok = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !ok) {
    await writeAudit({
      actorType: "USER",
      actorId: user?.id ?? null,
      actorLabel: identifier,
      action: "LOGIN_FAILED",
      resource: "session",
      ip,
      metadata: { reason: user ? "bad_password" : "unknown_user" },
    });
    return { error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" };
  }

  if (!user.isActive) {
    await writeAudit({
      actorType: "USER",
      actorId: user.id,
      actorLabel: identifier,
      action: "LOGIN_FAILED",
      resource: "session",
      facilityId: user.facilityId,
      ip,
      metadata: { reason: "pending_or_disabled" },
    });
    return { error: "บัญชีนี้ยังไม่ได้รับอนุมัติ หรือถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ" };
  }

  await setSessionCookie({
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    facilityId: user.facilityId,
    epoch: user.sessionEpoch,
  });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  await writeAudit({
    actorType: "USER",
    actorId: user.id,
    actorLabel: user.email,
    action: "LOGIN",
    resource: "session",
    facilityId: user.facilityId,
    ip,
  });

  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
