/**
 * Session revocation check.
 *
 * The JWT alone cannot know that an account was disabled, had its role changed
 * or its password reset two minutes ago - it stays valid until it expires. Every
 * such change bumps users.session_epoch, and this compares the epoch inside the
 * token with the one in the database, so a revoked session stops working almost
 * immediately instead of up to eight hours later.
 *
 * The result is cached briefly per instance: a page renders several server
 * components and none of them should each cost a database round trip.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

import type { SessionUser } from "./session";

interface CachedCheck {
  epoch: number;
  isActive: boolean;
  role: string;
  facilityId: string | null;
  checkedAt: number;
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, CachedCheck>();

export interface SessionCheck {
  valid: boolean;
  /** the account as the database currently sees it */
  current?: { role: string; facilityId: string | null };
}

export async function checkSessionStillValid(session: SessionUser): Promise<SessionCheck> {
  const cached = cache.get(session.userId);
  const fresh =
    cached && Date.now() - cached.checkedAt < CACHE_TTL_MS
      ? cached
      : await load(session.userId);

  if (!fresh) return { valid: false };
  if (!fresh.isActive) return { valid: false };
  if (fresh.epoch !== session.epoch) return { valid: false };

  return { valid: true, current: { role: fresh.role, facilityId: fresh.facilityId } };
}

async function load(userId: string): Promise<CachedCheck | null> {
  const [row] = await db
    .select({
      epoch: users.sessionEpoch,
      isActive: users.isActive,
      role: users.role,
      facilityId: users.facilityId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    cache.delete(userId);
    return null;
  }

  const entry: CachedCheck = { ...row, checkedAt: Date.now() };
  cache.set(userId, entry);
  // Keep the map from growing without bound on a long-lived instance.
  if (cache.size > 500) {
    for (const [key, value] of cache) {
      if (Date.now() - value.checkedAt > CACHE_TTL_MS) cache.delete(key);
    }
  }
  return entry;
}

/** Called after a change that must take effect immediately. */
export function forgetSessionCache(userId: string): void {
  cache.delete(userId);
}
