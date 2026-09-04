/**
 * Writes .env.vercel from the values this project already works with.
 *
 * Two of these must NOT be regenerated casually:
 *  - DATABASE_URL points at the database that already holds the data
 *  - AGENT_SIGNING_SECRET decrypts the credentials of agents already enrolled;
 *    a new value means every รพ.สต. has to enroll again
 * so both are copied from .env when present, and only the missing ones are
 * generated.
 *
 *   npm run env:vercel
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_URL = "https://drug-data-center-sankamphaeng.vercel.app";

function secret(existing: string | undefined): { value: string; generated: boolean } {
  if (existing && existing.length >= 32) return { value: existing, generated: false };
  return { value: randomBytes(48).toString("base64"), generated: true };
}

const database = process.env.DATABASE_URL ?? "";
const auth = secret(process.env.AUTH_SECRET);
const signing = secret(process.env.AGENT_SIGNING_SECRET);
const enrollment = secret(process.env.AGENT_ENROLLMENT_SECRET);
const baseUrl = process.env.API_BASE_URL || DEFAULT_URL;

const body = `# สร้างโดย npm run env:vercel เมื่อ ${new Date().toISOString()}
# ไฟล์นี้มีความลับจริง - ห้าม commit (อยู่ใน .gitignore แล้ว)
# นำไปวางใน Vercel: Project -> Settings -> Environment Variables (Production + Preview)

DATABASE_URL="${database}"
AUTH_SECRET="${auth.value}"
AGENT_SIGNING_SECRET="${signing.value}"
AGENT_ENROLLMENT_SECRET="${enrollment.value}"
API_BASE_URL="${baseUrl}"
AGENT_SIGNATURE_MAX_SKEW_SECONDS="300"
DATABASE_POOL_SIZE="3"
`;

const target = resolve(process.cwd(), ".env.vercel");
writeFileSync(target, body, { encoding: "utf8", mode: 0o600 });

console.log(`เขียน ${target} แล้ว`);
if (!database) console.warn("! DATABASE_URL ว่าง - เติมค่าจาก TiDB Cloud ก่อนนำไปใช้");
if (signing.generated) {
  console.warn(
    "! AGENT_SIGNING_SECRET ถูกสร้างใหม่ - ถ้ามี Agent ลงทะเบียนไว้แล้ว ต้อง enroll ใหม่ทุกเครื่อง",
  );
}
console.log("ค่าที่คัดมาจาก .env เดิม:", {
  DATABASE_URL: Boolean(database),
  AUTH_SECRET: !auth.generated,
  AGENT_SIGNING_SECRET: !signing.generated,
});
