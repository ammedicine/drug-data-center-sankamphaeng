/**
 * Small in-process rate limiter for the paths an attacker hits repeatedly:
 * login, registration and CSV export.
 *
 * Honest limitation: serverless instances do not share memory, so this caps a
 * burst per instance rather than globally. It is still worth having - it turns
 * an unattended password-guessing script into a slow one - and every attempt,
 * successful or not, is written to the audit log, which is the durable record.
 * A cluster-wide limiter (Vercel KV / Upstash) is the next step if the site is
 * ever exposed to the open internet.
 */
interface Bucket {
  hits: number;
  resetAt: number;
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitRule {
  /** how many attempts are allowed inside the window */
  limit: number;
  windowMs: number;
  /** how long to refuse everything once the limit is passed */
  blockMs: number;
}

export const LOGIN_RULE: RateLimitRule = {
  limit: 8,
  windowMs: 5 * 60_000,
  blockMs: 10 * 60_000,
};

export const REGISTER_RULE: RateLimitRule = {
  limit: 5,
  windowMs: 60 * 60_000,
  blockMs: 60 * 60_000,
};

export const EXPORT_RULE: RateLimitRule = {
  limit: 30,
  windowMs: 10 * 60_000,
  blockMs: 5 * 60_000,
};

/** The installer is a large file served to anonymous callers. */
export const DOWNLOAD_RULE: RateLimitRule = {
  limit: 6,
  windowMs: 10 * 60_000,
  blockMs: 10 * 60_000,
};

export interface RateLimitResult {
  allowed: boolean;
  /** seconds until the caller may try again (only when blocked) */
  retryAfterSeconds: number;
}

export function rateLimit(key: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: 0, resetAt: now + rule.windowMs, blockedUntil: 0 };

  if (bucket.blockedUntil > now) {
    buckets.set(key, bucket);
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000) };
  }

  if (now > bucket.resetAt) {
    bucket.hits = 0;
    bucket.resetAt = now + rule.windowMs;
  }

  bucket.hits += 1;
  if (bucket.hits > rule.limit) {
    bucket.blockedUntil = now + rule.blockMs;
    bucket.hits = 0;
    bucket.resetAt = now + rule.windowMs;
    buckets.set(key, bucket);
    return { allowed: false, retryAfterSeconds: Math.ceil(rule.blockMs / 1000) };
  }

  buckets.set(key, bucket);
  if (buckets.size > 5_000) {
    for (const [id, entry] of buckets) {
      if (entry.resetAt < now && entry.blockedUntil < now) buckets.delete(id);
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Clears the counter after a successful attempt, so one typo costs nothing. */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}
