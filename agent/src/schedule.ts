/**
 * When a scheduled sync actually runs.
 *
 * Every รพ.สต. tends to have the same settings, so "every hour" means every
 * agent in the district wakes at the top of the hour and hits Central and TiDB
 * within the same second. That is a thundering herd built out of a sensible
 * default, and it gets worse with each site added.
 *
 * The fix is an offset per agent, derived from its own id. It is deterministic
 * - the same machine lands in the same slot every time, which keeps the
 * schedule predictable and debuggable - and spread evenly, because the id is
 * hashed rather than used directly.
 *
 * Two rules the offset must not break:
 *
 * A time the operator typed is a time they meant. A daily sync set for 08:00
 * is nudged by seconds within its minute, never shifted to 08:04, or the
 * setting would be a suggestion rather than an instruction.
 *
 * "Sync now" is now. A person waiting at the screen is not part of any herd,
 * so a manual run is never delayed.
 */

import { createHash } from "node:crypto";

/** Interval runs spread across this window; roughly one clinic per 15s at 20 sites. */
export const STAGGER_WINDOW_SECONDS = 300;

/** A fixed clock time only ever moves within its own minute. */
export const DAILY_JITTER_SECONDS = 45;

/**
 * A stable number in [0, buckets) for this agent.
 *
 * Hashed rather than taken from the id's characters so that ids allocated in
 * sequence - which is how they are allocated - do not land in adjacent slots.
 */
export function agentSlot(agentId: string, buckets: number): number {
  if (buckets <= 0) return 0;
  const digest = createHash("sha256").update(agentId).digest();
  return digest.readUInt32BE(0) % buckets;
}

/**
 * How long this agent waits before installing an update everyone can see.
 *
 * Fifteen รพ.สต. watching the same release would otherwise all install within
 * a minute of each other and all restart together, and for that minute the
 * district has no agents reporting. Spread over half an hour, from the same
 * stable hash as the sync schedule, so a given clinic always takes the same
 * slot and two of them never collide by accident.
 *
 * Downloading is not staggered - it is idle bandwidth and hurts nobody. Only
 * the install and the restart wait.
 */
export const UPDATE_STAGGER_SECONDS = 30 * 60;

export function updateOffsetSeconds(agentId: string, window = UPDATE_STAGGER_SECONDS): number {
  return agentSlot(agentId, Math.max(1, window));
}

/**
 * How often an Agent asks Central whether a newer release exists.
 *
 * Thirty minutes, down from four hours. The check is cheap - one unauthenticated
 * GET that Central answers from GitHub's release record without touching the
 * database - and four hours meant a fix published in the morning reached the
 * last clinic in the afternoon. What is not cheap is fifteen clinics asking in
 * the same second, so each one is given its own minute within the half hour.
 */
export const UPDATE_CHECK_INTERVAL_MINUTES = 30;

/**
 * The minute within each half hour at which this Agent checks: 0..29.
 *
 * Derived from the same stable hash as everything else here, so a clinic keeps
 * its slot across restarts, reinstalls and upgrades, and two clinics only share
 * one by the ordinary odds of any hash - never because they were installed in
 * the same minute or restarted together after a power cut.
 *
 * The identity is whatever is stable on the machine at the moment the task is
 * written: the agentId once enrolled, the hostname before that. Either is fine.
 * What matters is that it does not change on its own.
 */
export function updateCheckSlotMinute(
  identity: string,
  intervalMinutes = UPDATE_CHECK_INTERVAL_MINUTES,
): number {
  return agentSlot(identity, Math.max(1, intervalMinutes));
}

/**
 * The `/ST` value for the scheduled task, as `HH:MM` inside the first half hour
 * of the day. schtasks anchors a MINUTE schedule to this time, so a task
 * started at 00:07 with a 30-minute interval runs at :07 and :37 of every hour
 * for as long as it exists - which is exactly the fixed, per-clinic phase
 * wanted. Measured on a real task before being relied on.
 */
export function updateCheckStartTime(identity: string): string {
  const minute = updateCheckSlotMinute(identity);
  return `00:${String(minute).padStart(2, "0")}`;
}

/** Seconds this agent waits after an interval becomes due. */
export function intervalOffsetSeconds(
  agentId: string,
  intervalMinutes: number,
  window = STAGGER_WINDOW_SECONDS,
): number {
  if (intervalMinutes <= 0) return 0;
  // Never spread beyond the interval itself: a five minute schedule staggered
  // across five minutes would let a slot drift into the following run.
  const span = Math.max(1, Math.min(window, intervalMinutes * 60 - 1));
  return agentSlot(agentId, span);
}

/** Seconds this agent waits after a daily time arrives. */
export function dailyOffsetSeconds(
  agentId: string,
  time: string,
  window = DAILY_JITTER_SECONDS,
): number {
  // Mixed with the time so an agent does not sit in the same slot for every
  // one of its daily runs.
  return agentSlot(`${agentId}:${time}`, Math.max(1, window));
}

/**
 * The moment the next scheduled run is expected, offset included.
 *
 * Recorded so the screen shows the time the sync will actually happen rather
 * than the time the schedule nominally fires - the whole point of staggering
 * is that those differ, and a status line that hides the difference would have
 * an operator reporting the agent as late.
 */
export function nextScheduledRun(input: {
  agentId: string;
  now: Date;
  intervalMinutes: number;
  dailyTimes: string[];
  lastIntervalRunAt: number | null;
}): Date | null {
  const candidates: number[] = [];
  const nowMs = input.now.getTime();

  if (input.intervalMinutes > 0) {
    const base = input.lastIntervalRunAt ?? nowMs;
    const offset = intervalOffsetSeconds(input.agentId, input.intervalMinutes) * 1000;
    candidates.push(base + input.intervalMinutes * 60_000 + offset);
  }

  for (const time of input.dailyTimes) {
    const text = String(time).trim();
    if (text.length !== 5 || text[2] !== ":") continue;
    const hour = Number(text.slice(0, 2));
    const minute = Number(text.slice(3));
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;

    const offset = dailyOffsetSeconds(input.agentId, text) * 1000;
    const todayRun = new Date(input.now);
    todayRun.setHours(hour, minute, 0, 0);
    const withOffset = todayRun.getTime() + offset;
    candidates.push(withOffset > nowMs ? withOffset : withOffset + 86_400_000);
  }

  if (!candidates.length) return null;
  return new Date(Math.min(...candidates));
}
