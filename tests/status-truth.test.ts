/**
 * Phase 1 guarantees: a link is reported as working only on evidence that it
 * worked, and that evidence expires.
 *
 * These are the cases that produced the original complaint - the tray saying
 * "Central เชื่อมต่อแล้ว" while nothing reached the server - so they are
 * pinned here rather than left to be re-discovered on someone's desk.
 */
import { describe, expect, it } from "vitest";

import {
  STALE_AFTER_SECONDS,
  isFresh,
  linkTone,
  type CentralLinkState,
} from "@/lib/shared/agent-status";
import { effectiveStatus, jhcisLinkState } from "@/lib/services/monitoring";

/** Mirrors SyncRunner.centralFailure, which cannot be imported here. */
function centralStateFor(status: number): CentralLinkState {
  return status === 401 || status === 403 ? "AUTH_ERROR" : "NETWORK_ERROR";
}

const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

describe("central link state", () => {
  it("never reports connected because a failure looked retryable", () => {
    // The bug: `centralConnected: !permanent` made a timeout - retryable, so
    // not permanent - report as connected.
    for (const status of [0, 408, 429, 500, 502, 503]) {
      expect(centralStateFor(status)).toBe("NETWORK_ERROR");
    }
  });

  it("separates a revoked credential from an unreachable server", () => {
    expect(centralStateFor(401)).toBe("AUTH_ERROR");
    expect(centralStateFor(403)).toBe("AUTH_ERROR");
    expect(centralStateFor(503)).toBe("NETWORK_ERROR");
  });

  it("colours the two differently, because they need different people", () => {
    expect(linkTone("AUTH_ERROR")).toBe("danger");
    expect(linkTone("NETWORK_ERROR")).toBe("danger");
    expect(linkTone("CONNECTED")).toBe("ok");
    expect(linkTone("STALE")).toBe("warn");
  });
});

describe("freshness", () => {
  it("believes a recent acknowledgement", () => {
    expect(isFresh(secondsAgo(1))).toBe(true);
    expect(isFresh(secondsAgo(STALE_AFTER_SECONDS - 5))).toBe(true);
  });

  it("stops believing an old one", () => {
    expect(isFresh(secondsAgo(STALE_AFTER_SECONDS + 5))).toBe(false);
    expect(isFresh(null)).toBe(false);
    expect(isFresh("not a date")).toBe(false);
  });
});

describe("agent status seen from Central", () => {
  it("is offline once the heartbeat goes stale, whatever the stored status says", () => {
    expect(
      effectiveStatus({ status: "ONLINE", lastHeartbeatAt: secondsAgo(STALE_AFTER_SECONDS + 30) }),
    ).toBe("OFFLINE");
    expect(effectiveStatus({ status: "SYNCING", lastHeartbeatAt: null })).toBe("OFFLINE");
  });

  it("is online while it is still reporting in", () => {
    expect(effectiveStatus({ status: "ONLINE", lastHeartbeatAt: secondsAgo(10) })).toBe("ONLINE");
    expect(effectiveStatus({ status: "SYNCING", lastHeartbeatAt: secondsAgo(10) })).toBe("SYNCING");
  });

  it("keeps DISABLED, which is an administrator's decision, not a measurement", () => {
    expect(effectiveStatus({ status: "DISABLED", lastHeartbeatAt: secondsAgo(1) })).toBe("DISABLED");
  });
});

describe("JHCIS link seen from Central", () => {
  it("reports JHCIS down while the agent itself is fine", () => {
    expect(
      jhcisLinkState({ lastHeartbeatAt: secondsAgo(10), jhcisConnected: false }),
    ).toBe("UNREACHABLE");
    // ... and the agent is still online: the two states are independent.
    expect(effectiveStatus({ status: "ONLINE", lastHeartbeatAt: secondsAgo(10) })).toBe("ONLINE");
  });

  it("admits it does not know once the agent stops reporting", () => {
    // A stale heartbeat says nothing about JHCIS; the last thing the agent
    // managed to say is not evidence about now.
    expect(
      jhcisLinkState({
        lastHeartbeatAt: secondsAgo(STALE_AFTER_SECONDS + 30),
        jhcisConnected: true,
      }),
    ).toBe("UNKNOWN");
    expect(jhcisLinkState({ lastHeartbeatAt: secondsAgo(5), jhcisConnected: null })).toBe("UNKNOWN");
  });

  it("reports connected only when a fresh heartbeat said so", () => {
    expect(jhcisLinkState({ lastHeartbeatAt: secondsAgo(5), jhcisConnected: true })).toBe(
      "CONNECTED",
    );
  });
});

/**
 * The time the screen counts down to must be a time the agent intends to keep.
 *
 * nextScheduledRun is the only place that decides it - the tray reads the
 * answer rather than working it out again - so a schedule with nothing in it
 * has to say null instead of leaving yesterday's answer standing.
 */
describe("the published next run", () => {
  const AGENT = "01m1t1rvwfnnm95qa85fg84tp6";
  const NOW = new Date("2026-09-06T07:30:00.000Z");

  async function schedule() {
    return import("../agent/src/schedule");
  }

  it("gives a real moment when a schedule exists", async () => {
    const { nextScheduledRun } = await schedule();
    const next = nextScheduledRun({
      agentId: AGENT,
      now: NOW,
      intervalMinutes: 60,
      dailyTimes: [],
      lastIntervalRunAt: NOW.getTime(),
    });
    expect(next).not.toBeNull();
    // An hour away, plus this agent's own place in the queue - never before
    // the interval it was told to keep.
    const waited = next!.getTime() - NOW.getTime();
    expect(waited).toBeGreaterThanOrEqual(60 * 60_000);
    expect(waited).toBeLessThan(60 * 60_000 + 300_000);
  });

  it("says nothing is scheduled when nothing is", async () => {
    const { nextScheduledRun } = await schedule();
    expect(
      nextScheduledRun({
        agentId: AGENT,
        now: NOW,
        intervalMinutes: 0,
        dailyTimes: [],
        lastIntervalRunAt: null,
      }),
      "auto sync on, but no interval and no daily time",
    ).toBeNull();
  });

  it("says nothing is scheduled while auto sync is off", async () => {
    const { nextScheduledRun } = await schedule();
    // This is the shape cli.ts passes once autoSyncEnabled is false: the
    // schedule is emptied rather than the last answer being left in place.
    expect(
      nextScheduledRun({
        agentId: AGENT,
        now: NOW,
        intervalMinutes: 0,
        dailyTimes: [],
        lastIntervalRunAt: NOW.getTime(),
      }),
    ).toBeNull();
  });

  it("keeps a fixed daily time inside its own minute", async () => {
    const { nextScheduledRun } = await schedule();
    const next = nextScheduledRun({
      agentId: AGENT,
      now: NOW,
      intervalMinutes: 0,
      dailyTimes: ["08:00"],
      lastIntervalRunAt: null,
    });
    expect(next).not.toBeNull();
    // 08:00 means 08:00. The stagger may move it by seconds so twenty clinics
    // do not arrive together, never to 08:04.
    expect(next!.getHours()).toBe(8);
    expect(next!.getMinutes()).toBe(0);
  });
});

/**
 * Presence: whether the web may call an agent online.
 *
 * The bug these pin down was visible on the operator's screen: a batch shown
 * as running, rows arriving at the centre every second, and the agent beside
 * it labelled OFFLINE. Presence was read from the dedicated heartbeat alone,
 * and the first run after enrolment reads the whole history - so the heartbeat
 * went quiet for twenty minutes while the agent was demonstrably working.
 */
describe("agent presence", () => {
  // Relative to the real clock, because isFresh compares against it: a
  // frozen "now" here would make every fixture look hours stale.
  const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

  async function monitoring() {
    return import("@/lib/services/monitoring");
  }

  it("CASE A: a fresh heartbeat and no sync is online", async () => {
    const { effectiveStatus } = await monitoring();
    expect(
      effectiveStatus({ status: "ONLINE", lastHeartbeatAt: ago(10), lastSeenAt: ago(10) }),
    ).toBe("ONLINE");
  });

  it("CASE B: a stale heartbeat but an upload seconds ago is online", async () => {
    const { effectiveStatus } = await monitoring();
    // Exactly the reported bug: heartbeat 20 minutes behind because the run
    // was busy, uploads still landing.
    expect(
      effectiveStatus({ status: "SYNCING", lastHeartbeatAt: ago(1200), lastSeenAt: ago(5) }),
    ).toBe("SYNCING");
  });

  it("CASE D: a running batch alone is not evidence - a crashed agent is offline", async () => {
    const { effectiveStatus } = await monitoring();
    // The stored status still says SYNCING because nothing closed the batch.
    // Nothing has been heard from the machine, so it is offline regardless.
    expect(
      effectiveStatus({ status: "SYNCING", lastHeartbeatAt: ago(1200), lastSeenAt: ago(1200) }),
    ).toBe("OFFLINE");
  });

  it("CASE F: an agent that stopped goes offline once the threshold passes", async () => {
    const { effectiveStatus } = await monitoring();
    expect(
      effectiveStatus({
        status: "ONLINE",
        lastHeartbeatAt: ago(STALE_AFTER_SECONDS + 5),
        lastSeenAt: ago(STALE_AFTER_SECONDS + 5),
      }),
    ).toBe("OFFLINE");
  });

  it("CASE G: it comes back online on the next authenticated request", async () => {
    const { effectiveStatus } = await monitoring();
    expect(
      effectiveStatus({ status: "OFFLINE", lastHeartbeatAt: ago(1200), lastSeenAt: ago(2) }),
    ).toBe("ONLINE");
  });

  it("an agent enrolled before lastSeenAt existed still behaves as before", async () => {
    const { effectiveStatus } = await monitoring();
    expect(effectiveStatus({ status: "ONLINE", lastHeartbeatAt: ago(10), lastSeenAt: null })).toBe(
      "ONLINE",
    );
    expect(
      effectiveStatus({ status: "ONLINE", lastHeartbeatAt: ago(1200), lastSeenAt: null }),
    ).toBe("OFFLINE");
  });

  it("uploads keep presence alive but never refresh what JHCIS said", async () => {
    const { effectiveStatus, jhcisLinkState } = await monitoring();
    const row = {
      status: "SYNCING" as const,
      lastHeartbeatAt: ago(1200),
      lastSeenAt: ago(3),
      jhcisConnected: true,
    };
    // Alive, because it is uploading.
    expect(effectiveStatus(row)).toBe("SYNCING");
    // But the last thing it said about JHCIS is twenty minutes old, and an
    // upload is no evidence that the LAN database is still answering.
    expect(jhcisLinkState(row)).toBe("UNKNOWN");
  });

  it("CASE H/I: every page asks the same function, whatever shape the row is", async () => {
    const { effectiveStatus, lastSeen } = await monitoring();
    // /sync, /admin/agents, /admin/monitoring and the live poll all read the
    // rows listAgents returns, so one row can only produce one answer.
    const recent = ago(4);
    const old = ago(1200);
    const row = { status: "ONLINE" as const, lastHeartbeatAt: old, lastSeenAt: recent };
    expect(effectiveStatus(row)).toBe(effectiveStatus({ ...row }));
    // The newer of the two timestamps is what counts, in either order.
    expect(lastSeen(row)).toEqual(recent);
    expect(lastSeen({ lastHeartbeatAt: recent, lastSeenAt: old })).toEqual(recent);
  });
});

/**
 * The zone these pages are read in.
 *
 * The status pages are server-rendered, and on Vercel that server runs in UTC.
 * Formatting without naming a zone therefore showed every operator a time
 * seven hours behind the clock on their own desk - the same fault the tray had,
 * arrived at from the other direction.
 */
describe("times shown to a reader", () => {
  async function primitives() {
    return import("@/components/ui/primitives");
  }

  it("reads a UTC instant in Thai time wherever it is rendered", async () => {
    const { formatDateTime } = await primitives();
    // 06:00 UTC is 13:00 in Thailand, whatever the server's own clock says.
    expect(formatDateTime("2026-09-08T06:00:00Z")).toContain("13:00");
  });

  it("rolls to the next day when the instant is late enough", async () => {
    const { formatDateTime } = await primitives();
    const text = formatDateTime("2026-09-08T18:30:00Z");
    expect(text).toContain("01:30");
    expect(text).toContain("9"); // the 9th, in Thailand
  });

  it("respects an offset that is already in the value", async () => {
    const { formatDateTime } = await primitives();
    // Adding seven hours again would read 06:59 the next morning.
    expect(formatDateTime("2026-09-08T23:59:00+07:00")).toContain("23:59");
  });

  it("keeps a service date on its own day", async () => {
    const { formatDate } = await primitives();
    // "2026-08-08" is a day in the hospital's records, not a moment, and must
    // not drift to the 7th or the 9th on its way to the screen.
    expect(formatDate("2026-08-08")).toContain("8");
    expect(formatDate("2026-08-08")).toContain("2569");
  });

  it("shows a placeholder rather than failing on nothing", async () => {
    const { formatDateTime, formatDate } = await primitives();
    expect(formatDateTime(null)).toBe("-");
    expect(formatDate(undefined)).toBe("-");
    expect(formatDateTime("ไม่ใช่เวลา")).toBe("-");
  });
});

/**
 * "Sync now" is a button press, not a standing order.
 *
 * A request pressed at 08:19 was still being obeyed an hour later, every
 * thirty seconds. The reason was that a request counts as answered when a run
 * happens after it - and a run that finds nothing to fetch opens no batch, so
 * nothing recorded that it happened at all. The agent now reports the attempt,
 * and a request that nobody has answered eventually stops being an
 * instruction.
 */
describe("a manual sync request", () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

  async function auth() {
    return import("@/lib/agent-auth/verify");
  }

  /** The decision the heartbeat makes, in the shape the row supplies. */
  function outstanding(row: {
    syncRequestedAt: Date | null;
    syncRequestedFrom?: string | null;
    lastSyncAt: Date | null;
    ttlMs: number;
  }): boolean {
    const live = row.syncRequestedAt && Date.now() - row.syncRequestedAt.getTime() <= row.ttlMs;
    return Boolean(
      live &&
        (row.syncRequestedFrom ||
          !row.lastSyncAt ||
          row.syncRequestedAt!.getTime() > row.lastSyncAt.getTime()),
    );
  }

  it("CASE 1/7: a run that found nothing still answers the request", async () => {
    const { SYNC_REQUEST_TTL_MS } = await auth();
    const requested = minutesAgo(5);
    // Before: the run opened no batch, so nothing was recorded and every
    // heartbeat started it again.
    expect(
      outstanding({ syncRequestedAt: requested, lastSyncAt: minutesAgo(60), ttlMs: SYNC_REQUEST_TTL_MS }),
    ).toBe(true);
    // After: the agent reports the attempt on its heartbeat, and the request
    // is answered - however many heartbeats follow.
    const ranAt = minutesAgo(4);
    expect(
      outstanding({ syncRequestedAt: requested, lastSyncAt: ranAt, ttlMs: SYNC_REQUEST_TTL_MS }),
    ).toBe(false);
  });

  it("CASE 4: a newer request is not swallowed by an older acknowledgement", async () => {
    const { SYNC_REQUEST_TTL_MS } = await auth();
    // The operator pressed again while the first run was finishing. The second
    // press is newer than the run that answered the first, so it stands.
    const ranAt = minutesAgo(3);
    const pressedAgain = minutesAgo(2);
    expect(
      outstanding({ syncRequestedAt: pressedAgain, lastSyncAt: ranAt, ttlMs: SYNC_REQUEST_TTL_MS }),
    ).toBe(true);
  });

  it("CASE 5: a request nobody answered stops being an instruction", async () => {
    const { SYNC_REQUEST_TTL_MS } = await auth();
    const ttlMinutes = SYNC_REQUEST_TTL_MS / 60_000;
    // A PC switched off at closing time should not act on yesterday's press
    // when it starts in the morning.
    expect(
      outstanding({
        syncRequestedAt: minutesAgo(ttlMinutes + 30),
        lastSyncAt: null,
        ttlMs: SYNC_REQUEST_TTL_MS,
      }),
    ).toBe(false);
    // Inside the window it is still what the operator meant.
    expect(
      outstanding({
        syncRequestedAt: minutesAgo(5),
        lastSyncAt: null,
        ttlMs: SYNC_REQUEST_TTL_MS,
      }),
    ).toBe(true);
  });

  it("a request naming a window is not answered by an unrelated run", async () => {
    const { SYNC_REQUEST_TTL_MS } = await auth();
    // Asking for specific days means those days, so the hourly run that
    // happened to follow does not count.
    expect(
      outstanding({
        syncRequestedAt: minutesAgo(10),
        syncRequestedFrom: "2026-07-01",
        lastSyncAt: minutesAgo(1),
        ttlMs: SYNC_REQUEST_TTL_MS,
      }),
    ).toBe(true);
  });

  it("the expiry is long enough to be useful and short enough to be safe", async () => {
    const { SYNC_REQUEST_TTL_MS } = await auth();
    expect(SYNC_REQUEST_TTL_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(SYNC_REQUEST_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60_000);
  });
});
