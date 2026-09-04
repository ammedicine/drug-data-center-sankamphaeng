"use server";

import { eq, or } from "drizzle-orm";
import { headers } from "next/headers";

import { hashPassword, validatePasswordStrength } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { facilities, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { clientIp, writeAudit } from "@/lib/services/audit";

export interface RegisterState {
  error?: string;
  success?: string;
}

const USERNAME_RE = /^[a-zA-Z0-9._-]{4,60}$/;

/**
 * Self-service registration (สมัครสมาชิก).
 *
 * The account is bound to a facility by its 5-digit รหัสสถานบริการ (the JHCIS
 * pcucode), which is what every downstream query scopes on.
 *
 * A new account is created INACTIVE on purpose: registration is open to anyone
 * who can reach the site, so letting it grant immediate access to a facility's
 * data would be the same as having no facility isolation at all. A SUPER_ADMIN
 * (or the facility's own admin) approves it in /admin/users.
 */
export async function registerAction(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const fullName = String(formData.get("fullName") ?? "").trim();
  const position = String(formData.get("position") ?? "").trim();
  const username = String(formData.get("username") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");
  const pcucode = String(formData.get("facilityCode") ?? "").trim();
  const facilityName = String(formData.get("facilityName") ?? "").trim();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!fullName) return { error: "กรุณากรอกชื่อ-นามสกุล" };
  if (!position) return { error: "กรุณากรอกตำแหน่ง" };
  if (!USERNAME_RE.test(username)) {
    return { error: "ชื่อผู้ใช้ต้องยาว 4-60 ตัว ใช้ได้เฉพาะ a-z 0-9 . _ -" };
  }
  const weak = validatePasswordStrength(password);
  if (weak) return { error: weak };
  if (password !== confirm) return { error: "รหัสผ่านทั้งสองช่องไม่ตรงกัน" };
  if (!/^\d{5}$/.test(pcucode)) return { error: "รหัสสถานบริการต้องเป็นตัวเลข 5 หลัก" };
  if (!facilityName) return { error: "กรุณากรอกชื่อสถานบริการ" };

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.username, username), eq(users.email, email || `${username}@local`)))
    .limit(1);
  if (existing) return { error: "ชื่อผู้ใช้หรืออีเมลนี้ถูกใช้แล้ว" };

  // The facility is matched by pcucode. A new pcucode creates the facility
  // record so the first person from a รพ.สต. can register, but the account
  // still has to be approved before it can read anything.
  const [facility] = await db
    .select({ id: facilities.id, name: facilities.name, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.jhcisPcucode, pcucode))
    .limit(1);

  let facilityId = facility?.id;
  if (!facilityId) {
    facilityId = newId();
    try {
      await db.insert(facilities).values({
        id: facilityId,
        code: `RPST-${pcucode}`,
        jhcisPcucode: pcucode,
        name: facilityName,
        province: "เชียงใหม่",
        district: "สันกำแพง",
      });
    } catch {
      return { error: "ไม่สามารถสร้างสถานบริการได้ กรุณาตรวจสอบรหัสสถานบริการ" };
    }
  }

  const userId = newId();
  try {
    await db.insert(users).values({
      id: userId,
      username,
      email: email || `${username}@rpst-${pcucode}.local`,
      fullName,
      position,
      passwordHash: await hashPassword(password),
      role: "USER",
      facilityId,
      isActive: false,
    });
  } catch {
    return { error: "ชื่อผู้ใช้หรืออีเมลนี้ถูกใช้แล้ว" };
  }

  await writeAudit({
    actorType: "USER",
    actorId: userId,
    actorLabel: username,
    action: "USER_CREATE",
    resource: "user",
    resourceId: userId,
    facilityId,
    ip: clientIp(await headers()),
    metadata: { self_registered: true, pcucode, position },
  });

  return {
    success: `สมัครสมาชิกเรียบร้อย บัญชี "${username}" ผูกกับสถานบริการ ${
      facility?.name ?? facilityName
    } (${pcucode}) — รอผู้ดูแลระบบอนุมัติก่อนจึงจะเข้าใช้งานได้`,
  };
}
