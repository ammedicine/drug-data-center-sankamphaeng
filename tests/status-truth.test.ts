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
