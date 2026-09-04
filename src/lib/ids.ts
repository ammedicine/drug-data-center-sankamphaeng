import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, no ambiguous chars

/** Sortable, URL-safe id: <time><random>, 26 chars, fits varchar(30). */
export function newId(prefix = ""): string {
  let time = Date.now();
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ALPHABET[time % 32]);
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i++) random += ALPHABET[rand[i] % 32];
  const value = timeChars.join("") + random;
  return prefix ? `${prefix}_${value.slice(0, 26 - prefix.length - 1)}` : value;
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time comparison for hex/ascii digests of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function newUuid(): string {
  return randomUUID();
}
