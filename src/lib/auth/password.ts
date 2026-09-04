import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Minimum policy for a healthcare back office; enforced on every write path. */
export function validatePasswordStrength(plain: string): string | null {
  if (plain.length < 10) return "รหัสผ่านต้องมีอย่างน้อย 10 ตัวอักษร";
  if (!/[a-z]/i.test(plain)) return "รหัสผ่านต้องมีตัวอักษร";
  if (!/[0-9]/.test(plain)) return "รหัสผ่านต้องมีตัวเลข";
  return null;
}
