/**
 * Bootstraps the first SUPER_ADMIN and (optionally) the first facility.
 * Usage:
 *   SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... npm run db:seed
 *
 * The password is read from the environment and never written to a file.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";

import { hashPassword, validatePasswordStrength } from "../src/lib/auth/password";
import { db } from "../src/lib/db";
import { facilities, users } from "../src/lib/db/schema";
import { newId } from "../src/lib/ids";

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (!email || !password) {
    throw new Error("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required");
  }
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    console.log(`user ${email} already exists - nothing to do`);
    return;
  }

  await db.insert(users).values({
    id: newId(),
    email,
    fullName: process.env.SEED_ADMIN_NAME ?? "ผู้ดูแลระบบส่วนกลาง",
    passwordHash: await hashPassword(password),
    role: "SUPER_ADMIN",
    facilityId: null,
  });
  console.log(`created SUPER_ADMIN ${email}`);

  // Optional first facility, handy for a local end-to-end test with the agent.
  const code = process.env.SEED_FACILITY_CODE;
  const pcucode = process.env.SEED_FACILITY_PCUCODE;
  if (code && pcucode) {
    const [facility] = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.jhcisPcucode, pcucode));
    if (!facility) {
      await db.insert(facilities).values({
        id: newId(),
        code,
        jhcisPcucode: pcucode,
        name: process.env.SEED_FACILITY_NAME ?? `รพ.สต. ${code}`,
        province: "เชียงใหม่",
        district: "สันกำแพง",
      });
      console.log(`created facility ${code} (pcucode ${pcucode})`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
