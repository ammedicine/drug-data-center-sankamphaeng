"use server";

import { eq } from "drizzle-orm";
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
 * Password login. The same generic message is returned for unknown accounts and
 * wrong passwords so the form cannot be used to enumerate users.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const ip = clientIp(await headers());

  if (!email || !password) {
    return { error: "กรุณากรอกอีเมลและรหัสผ่าน" };
  }

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      facilityId: users.facilityId,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
      sessionEpoch: users.sessionEpoch,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const ok = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !ok || !user.isActive) {
    await writeAudit({
      actorType: "USER",
      actorId: user?.id ?? null,
      actorLabel: email,
      action: "LOGIN_FAILED",
      resource: "session",
      ip,
      metadata: { reason: !user ? "unknown_user" : !ok ? "bad_password" : "inactive" },
    });
    return { error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" };
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
