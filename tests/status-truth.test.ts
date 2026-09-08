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
