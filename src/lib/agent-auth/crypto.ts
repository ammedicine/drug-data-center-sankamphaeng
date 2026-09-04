/**
 * Envelope encryption for agent shared secrets.
 *
 * Secrets must be recoverable (the server needs the plaintext to recompute an
 * HMAC), so hashing is not an option - instead they are encrypted at rest with
 * AGENT_SIGNING_SECRET. A database dump alone is therefore not enough to forge
 * agent requests.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function masterKey(): Buffer {
  const secret = process.env.AGENT_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AGENT_SIGNING_SECRET is missing or too short (need >= 32 chars).");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Returns "v1.<iv>.<tag>.<ciphertext>", all base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(
    ".",
  );
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed agent credential envelope");
  }
  const decipher = createDecipheriv(ALGORITHM, masterKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
