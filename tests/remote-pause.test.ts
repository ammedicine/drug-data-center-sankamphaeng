/**
 * Stopping a สถานบริการ from writing to Central, from the district office.
 *
 * The owner has Agents on networks nobody at the office can reach. Before the
 * centre's data is deliberately reset, every one of them has to be unable to
 * put rows back in - including one that is switched off, one on an older build
 * that has never heard of pausing, and one that comes back online days later
 * with a full queue. None of those can be made to cooperate, so cooperation
 * cannot be what the guarantee rests on.
 *
 * These tests are about the guarantee, not the courtesy: what the centre
 * refuses, and what shape that refusal takes for a client that predates it.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_START_DATE,
  SYNC_PAUSED_CODE,
  SYNC_PAUSED_RETRY_AFTER_SECONDS,
  SYNC_PAUSED_STATUS,
  applySyncStartFloor,
  controlAckState,
  ingestAllowed,
  isValidSyncStartDate,
  toThaiDate,
} from "@/lib/shared/sync-control";
import { NO_CAPABILITIES, parseBuildId, parseCapabilities } from "@/lib/shared/agent-build";

describe("what the refusal has to look like for the clients already installed", () => {
  it("is 503 with a short Retry-After, never 4xx", () => {
    // Measured against the released v1.1.7 client rather than chosen. There,
    // CentralApiError.permanent is `status >= 400 && < 500 && !== 408 && !==
    // 429`, and a permanent failure makes the upload loop rewrite every
    // pending chunk into failed/ in one pass and report an auth failure -
    // which v1.1.6's tray renders as "สิทธิ์ถูกเพิกถอน". A clinic would be
    // told its credential was cancelled because somebody paused it.
    expect(SYNC_PAUSED_STATUS).toBe(503);
    const permanent = (status: number) =>
      status >= 400 && status < 500 && status !== 408 && status !== 429;
    expect(permanent(SYNC_PAUSED_STATUS)).toBe(false);
    expect(permanent(401)).toBe(true);
    expect(permanent(403)).toBe(true);

    // And the wait must stay small. An hour would park an old agent inside a
    // single upload for five hours.
    // withRetry makes 5 attempts with a sleep between each - 4 sleeps - all
    // while holding sync.lock, which another worker may take over after 5
    // minutes. The total sleeping must stay comfortably inside that, or a
    // paused agent could end up running two concurrent syncs when it resumes.
    const ATTEMPTS = 5;
    const SYNC_LOCK_STALE_SECONDS = 5 * 60;
    const totalSleep = SYNC_PAUSED_RETRY_AFTER_SECONDS * (ATTEMPTS - 1);
    expect(totalSleep).toBeLessThan(SYNC_LOCK_STALE_SECONDS * 0.75);
  });

  it("carries a code a new client can act on and an old one can ignore", () => {
    expect(SYNC_PAUSED_CODE).toBe("SYNC_PAUSED_BY_ADMIN");
    // Not one of the codes that mean the credential is gone - that distinction
    // is what stopped v1.1.7 telling clinics to re-enrol over a clock error.
    expect(["AGENT_DISABLED", "UNKNOWN_KEY", "CREDENTIAL_REVOKED"]).not.toContain(
      SYNC_PAUSED_CODE,
    );
  });
});

describe("who decides", () => {
  it("ingestion follows the centre alone", () => {
    // The agent's opinion is not an input. That is the whole point: an agent
    // that is off, old, or lying still cannot write.
    expect(ingestAllowed("RUNNING")).toBe(true);
    expect(ingestAllowed("PAUSED")).toBe(false);
  });

  it("an agent that can never acknowledge is still reported honestly", () => {
    // A v1.1.7 machine has no idea what a pause is. The screen must not show
    // it as pending forever, and must not pretend it agreed either.
    expect(
      controlAckState({
        desired: "PAUSED",
        effective: null,
        controlRevision: 3,
        appliedRevision: null,
        supportsRemotePause: false,
      }),
    ).toBe("UNSUPPORTED");

    // A capable agent that has not answered yet.
    expect(
      controlAckState({
        desired: "PAUSED",
        effective: "RUNNING",
        controlRevision: 3,
        appliedRevision: 2,
        supportsRemotePause: true,
      }),
    ).toBe("PAUSE_PENDING");

    // Caught up.
    expect(
      controlAckState({
        desired: "PAUSED",
        effective: "PAUSED",
        controlRevision: 3,
        appliedRevision: 3,
        supportsRemotePause: true,
      }),
    ).toBe("IN_SYNC");

    // Mid-handover: told to stop, finishing the chunk it was in. Not yet
    // stopped, and the screen should not claim it is.
    expect(
      controlAckState({
        desired: "PAUSED",
        effective: "PAUSE_REQUESTED",
        controlRevision: 3,
        appliedRevision: 3,
        supportsRemotePause: true,
      }),
    ).toBe("PAUSE_PENDING");
  });
});

describe("the collection floor", () => {
  it("defaults to the start of the 2566 fiscal year", () => {
    expect(DEFAULT_SYNC_START_DATE).toBe("2022-10-01");
    expect(toThaiDate(DEFAULT_SYNC_START_DATE)).toBe("01/10/2565");
  });

  it("refuses anything that is not a real ISO date", () => {
    // This value becomes a SQL predicate. A hand-edited settings.json with
    // nonsense in it must not quietly read everything back to 2006.
    expect(isValidSyncStartDate("2022-10-01")).toBe(true);
    expect(isValidSyncStartDate("2022-02-30")).toBe(false);
    expect(isValidSyncStartDate("2022-13-01")).toBe(false);
    expect(isValidSyncStartDate("01/10/2565")).toBe(false);
    expect(isValidSyncStartDate("2022-10-01T00:00:00Z")).toBe(false);
    expect(isValidSyncStartDate("")).toBe(false);
  });

  it("raises a range that starts too early and leaves a later one alone", () => {
    // The case that matters: after the centre's data for a สถานบริการ is
    // cleared, the agent has no watermark and would otherwise walk back to
    // whatever JHCIS holds. At 05957 that was 2006, and 252,698 of the 268,474
    // rows it collected were older than the สถานบริการ meant to keep.
    expect(applySyncStartFloor("2006-10-31", "2022-10-01")).toBe("2022-10-01");
    expect(applySyncStartFloor("2024-01-01", "2022-10-01")).toBe("2024-01-01");
    expect(applySyncStartFloor("2022-10-01", "2022-10-01")).toBe("2022-10-01");
  });
});

describe("telling builds apart", () => {
  it("reads a missing capability as no, never as unknown", () => {
    // An older agent sends none of this. "Cannot do that" is the correct
    // reading, and it is what makes the centre rely on its own barrier rather
    // than on an assumption about the client.
    expect(parseCapabilities(undefined)).toEqual(NO_CAPABILITIES);
    expect(parseCapabilities(null)).toEqual(NO_CAPABILITIES);
    expect(parseCapabilities({ remotePause: true }).remotePause).toBe(true);
    expect(parseCapabilities({ remotePause: true }).autoUpdate).toBe(false);
    // Only a real boolean true counts - a string "true" is not a capability.
    expect(parseCapabilities({ remotePause: "true" }).remotePause).toBe(false);
  });

  it("accepts a commit hash and nothing else", () => {
    // This is drawn on an operator's screen, so a field the agent controls
    // must not be able to carry markup, a path, or anything long.
    expect(parseBuildId("02eec74")).toBe("02eec74");
    expect(parseBuildId("02EEC74")).toBe("02eec74");
    expect(parseBuildId("02eec74df879b36929d95de115758d5a0c0b9521")).toBeTruthy();
    expect(parseBuildId("<script>")).toBeNull();
    expect(parseBuildId("../../etc/passwd")).toBeNull();
    expect(parseBuildId("zzzz")).toBeNull();
    expect(parseBuildId(42)).toBeNull();
    expect(parseBuildId("")).toBeNull();
  });
});
