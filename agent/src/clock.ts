/**
 * Is this PC's clock right?
 *
 * The signature on every request carries a timestamp, and Central refuses one
 * that is more than five minutes from its own clock. That is a replay control
 * and it is not negotiable - nothing here widens it, and nothing here signs a
 * request with anything but this machine's real clock. What went wrong was the
 * diagnosis: a รพ.สต. whose Windows clock had drifted 41 minutes was told its
 * Agent's credential had been cancelled, and someone went to re-enrol a
 * machine that only needed its clock set.
 *
 * So the Agent measures the difference itself, says so plainly, and asks
 * Windows to fix it - within bounds. Windows Time either works or it does not;
 * running w32tm every few seconds for ever would achieve nothing except noise
 * in the event log.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  CLOCK_HEALTHY_SECONDS,
  CLOCK_SKEW_LIMIT_SECONDS,
  clockStateFor,
  type ClockState,
} from "@shared/agent-status";

import { log } from "./logger";

const run = promisify(execFile);

/** Long enough that a burst of failures cannot turn into a burst of requests. */
export const CLOCK_CHECK_MIN_INTERVAL_MS = 60_000;

/** Attempts to repair the clock before giving up and asking a person. */
export const CLOCK_SYNC_MAX_ATTEMPTS = 3;

/** Waits between repair attempts: Windows Time is not instant. */
export const CLOCK_SYNC_DELAYS_MS = [5_000, 15_000, 30_000];

/** How long to leave it alone after the attempts are exhausted. */
export const CLOCK_SYNC_COOLDOWN_MS = 30 * 60_000;

export interface ClockReading {
  state: ClockState;
  /** local minus central, in seconds; positive means this PC is ahead */
  skewSeconds: number;
  serverTime: string;
  checkedAt: string;
}

/**
 * Asks Central what time it is.
 *
 * Deliberately unauthenticated: a machine whose clock is wrong cannot sign a
 * request Central will accept, so anything behind the signature is exactly
 * what it cannot reach. The round trip is halved out of the comparison, which
 * is enough at the resolution that matters here - we are looking for minutes,
 * not milliseconds.
 */
export async function readCentralClock(baseUrl: string): Promise<ClockReading> {
  const url = new URL("/api/time", baseUrl).toString();
  const startedAt = Date.now();
  // Node's fetch does not cache, and the route sends no-store anyway; the
  // header is here so an intermediate proxy cannot answer from a stale copy,
  // which would be worse than no answer.
  const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`เวลาศูนย์กลางตอบกลับ ${response.status}`);

  const payload = (await response.json()) as { serverUnixMs?: number; serverTime?: string };
  const serverUnixMs = Number(payload.serverUnixMs);
  if (!Number.isFinite(serverUnixMs)) throw new Error("เวลาศูนย์กลางไม่ถูกต้อง");

  const finishedAt = Date.now();
  // The reply describes a moment somewhere inside the round trip; comparing it
  // with the midpoint keeps the transit time out of the measured drift.
  const localAtReply = startedAt + (finishedAt - startedAt) / 2;
  const skewSeconds = Math.round((localAtReply - serverUnixMs) / 1000);

  return {
    state: clockStateFor(skewSeconds),
    skewSeconds,
    serverTime: payload.serverTime ?? new Date(serverUnixMs).toISOString(),
    checkedAt: new Date(finishedAt).toISOString(),
  };
}

export interface TimeSyncOutcome {
  ok: boolean;
  /** short, safe reason for the window and the log - never a raw command dump */
  detail: string;
}

/**
 * Asks Windows to resynchronise its clock.
 *
 * `w32tm /resync` is the supported way and needs the Windows Time service to
 * be running and to have a source. It also needs rights this program does not
 * have when a member of staff is signed in normally, which is why the
 * installer registers a scheduled task to run this same executable elevated;
 * this function is what that task ends up calling.
 *
 * Nothing here reconfigures NTP servers or touches the service's start type.
 * A clinic PC that cannot reach a time source has a network or policy problem,
 * and quietly rewriting its time configuration would hide that rather than fix
 * it.
 */
export async function requestWindowsTimeSync(): Promise<TimeSyncOutcome> {
  if (process.platform !== "win32") {
    return { ok: false, detail: "ไม่ใช่ Windows จึงซิงก์เวลาไม่ได้" };
  }

  try {
    // Start the service if it is merely stopped. If policy forbids it, this
    // fails and the resync below reports the real reason.
    await run("net", ["start", "w32time"], { timeout: 30_000 }).catch(() => undefined);
    const { stdout } = await run("w32tm", ["/resync"], { timeout: 60_000 });
    const text = stdout.trim();
    log.info("ขอให้ Windows ซิงก์เวลาแล้ว", { detail: text.slice(0, 160) });
    return { ok: true, detail: text.slice(0, 200) || "สั่งซิงก์เวลาแล้ว" };
  } catch (error) {
    const raw = error as { stdout?: string; stderr?: string; message?: string };
    const detail = (raw.stderr || raw.stdout || raw.message || "").trim().slice(0, 200);
    return { ok: false, detail: detail || "สั่งซิงก์เวลาไม่สำเร็จ" };
  }
}

/**
 * Measures, repairs if needed, and measures again - a bounded number of times.
 *
 * Stops the moment the clock is healthy. When the attempts run out it returns
 * CLOCK_SYNC_FAILED, which is a state a person has to act on, not a state to
 * keep retrying: the caller applies a cooldown rather than looping.
 */
export async function healClock(
  baseUrl: string,
  options: { sync?: () => Promise<TimeSyncOutcome>; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ reading: ClockReading; attempts: number; detail: string }> {
  const sync = options.sync ?? requestWindowsTimeSync;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  let reading = await readCentralClock(baseUrl);
  if (reading.state === "HEALTHY") return { reading, attempts: 0, detail: "เวลาตรงอยู่แล้ว" };

  let detail = "";
  for (let attempt = 0; attempt < CLOCK_SYNC_MAX_ATTEMPTS; attempt++) {
    log.warn("เวลาเครื่องคลาดเคลื่อน กำลังสั่งซิงก์เวลา Windows", {
      skewSeconds: reading.skewSeconds,
      attempt: attempt + 1,
    });
    const outcome = await sync();
    detail = outcome.detail;
    await wait(CLOCK_SYNC_DELAYS_MS[Math.min(attempt, CLOCK_SYNC_DELAYS_MS.length - 1)]);

    reading = await readCentralClock(baseUrl);
    if (reading.state === "HEALTHY") {
      log.info("เวลาเครื่องตรงกับศูนย์กลางแล้ว", {
        skewSeconds: reading.skewSeconds,
        attempts: attempt + 1,
      });
      return { reading, attempts: attempt + 1, detail };
    }
  }

  log.warn("ซิงก์เวลา Windows ไม่สำเร็จตามจำนวนครั้งที่กำหนด", {
    skewSeconds: reading.skewSeconds,
    detail: detail.slice(0, 120),
  });
  return {
    reading: { ...reading, state: "CLOCK_SYNC_FAILED" },
    attempts: CLOCK_SYNC_MAX_ATTEMPTS,
    detail,
  };
}

export { CLOCK_HEALTHY_SECONDS, CLOCK_SKEW_LIMIT_SECONDS };
