/**
 * The gap between rendering a status page and hydrating it.
 *
 * /sync and /admin/monitoring are server-rendered and then poll a light
 * endpoint to decide when they are worth rebuilding. The first poll used to be
 * recorded as a baseline and nothing more, so anything that changed while the
 * page was in flight - an agent going offline, a run finishing - was never
 * noticed. With no further change to trigger a comparison, and an agent that
 * is offline produces no further change, the page kept showing the old answer
 * for as long as it was left open.
 *
 * The page now hands the browser the signature of what it is showing, so the
 * first poll has something true to compare against. These cases are about that
 * comparison: server rows in, poll payload in, refresh or not out.
 */
import { describe, expect, it } from "vitest";

import { liveSignature, shouldRefresh } from "@/lib/shared/live-signature";

const HEARTBEAT = new Date("2026-09-08T02:00:00.000Z");

/** A row as the page has it: Date objects, and status under effectiveStatus. */
function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    status: "ONLINE",
    jhcisState: "CONNECTED",
    lastHeartbeatAt: HEARTBEAT,
    lastSuccessfulSyncAt: HEARTBEAT,
    lastSyncedVisitDate: "2026-08-08",
    pendingBatches: 0,
    version: "1.0.3",
    lastError: null,
    ...overrides,
  };
}

/** The same row as the poll returns it: JSON, so timestamps are strings. */
function polled(overrides: Record<string, unknown> = {}) {
  return {
    ...serverRow(),
    lastHeartbeatAt: HEARTBEAT.toISOString(),
    lastSuccessfulSyncAt: HEARTBEAT.toISOString(),
    ...overrides,
  };
}

const RUN = {
  batchRef: "SYNC-20260908-000001",
  recordsAccepted: 500,
  recordsRejected: 0,
  progress: 0.4,
};

describe("the first poll after a page is rendered", () => {
  it("CASE A: nothing changed, so nothing is rebuilt", () => {
    // The server had Date objects and the poll has ISO strings. If those did
    // not normalise to the same text, every page load would rebuild itself
    // once for no reason, and this test would be the only thing to notice.
    const rendered = liveSignature({ agents: [serverRow()], running: [] });
    const first = liveSignature({ agents: [polled()], running: [] });
    expect(first).toBe(rendered);
    expect(shouldRefresh(rendered, first)).toBe(false);
  });

  it("CASE B: the agent went offline in the gap, and the page must follow", () => {
    const rendered = liveSignature({ agents: [serverRow()], running: [] });
    const first = liveSignature({
      agents: [polled({ status: "OFFLINE", jhcisState: "UNKNOWN" })],
      running: [],
    });
    expect(shouldRefresh(rendered, first)).toBe(true);
  });

  it("CASE C: the run finished in the gap, and the page must stop saying it is running", () => {
    const rendered = liveSignature({ agents: [serverRow()], running: [RUN] });
    const first = liveSignature({
      agents: [polled({ lastSuccessfulSyncAt: "2026-09-08T02:00:30.000Z" })],
      running: [],
    });
    expect(shouldRefresh(rendered, first)).toBe(true);
  });

  it("only rebuilds for things a reader would see", () => {
    const rendered = liveSignature({ agents: [serverRow()], running: [] });
    // Progress within a running batch counts; the batch's own start time and
    // the agent's IP address are not part of the answer, so a page is not
    // rebuilt for them.
    const cosmetic = liveSignature({
      agents: [polled({ ipAddress: "10.0.0.9", hostname: "renamed" })],
      running: [],
    });
    expect(shouldRefresh(rendered, cosmetic)).toBe(false);

    const real = liveSignature({
      agents: [polled({ pendingBatches: 3 })],
      running: [],
    });
    expect(shouldRefresh(rendered, real)).toBe(true);
  });

  it("is deterministic, and carries nothing that changes on its own", () => {
    const once = liveSignature({ agents: [serverRow()], running: [] });
    expect(liveSignature({ agents: [serverRow()], running: [] })).toBe(once);

    // serverTime moves on every poll. If it reached the signature the page
    // would rebuild itself every five seconds for ever, so the whole snapshot
    // is handed in and only the parts that matter are read out of it.
    expect(once).not.toContain("serverTime");
    const wholeSnapshot = liveSignature({
      serverTime: new Date().toISOString(),
      agents: [polled()],
      running: [],
    } as never);
    expect(wholeSnapshot).toBe(once);

    // A field that is absent and one that is explicitly null describe the same
    // state, and must not read as a change between two polls.
    const missing = liveSignature({
      agents: [{ ...polled(), lastError: undefined }],
      running: [],
    } as never);
    expect(missing).toBe(once);
  });

  it("without a starting point, the first poll is still only a baseline", () => {
    // The old behaviour, kept for any caller that cannot supply one: taking an
    // unknown previous state as news would rebuild every page on load.
    const first = liveSignature({ agents: [polled()], running: [] });
    expect(shouldRefresh(null, first)).toBe(false);
    // ...and the poll after it compares normally.
    const second = liveSignature({ agents: [polled({ status: "OFFLINE" })], running: [] });
    expect(shouldRefresh(first, second)).toBe(true);
  });
});
