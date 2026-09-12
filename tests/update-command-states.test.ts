/**
 * The update command's state table, checked as a table.
 *
 * Every transition the centre will accept from an Agent, and every one it
 * will refuse, is listed here rather than discovered in production. The
 * screen's Thai labels are checked for completeness too, because a state
 * without a label renders as its enum name and nobody should read
 * "WAITING_FOR_IDLE" on a clinic dashboard.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_REPORTED_STATES,
  canTransition,
  isTransientUpdateError,
  MAX_ACTIVE_ROLLOUT,
  ROLLOUT_ACTIVE_STATES,
  TERMINAL_UPDATE_STATES,
  UPDATE_COMMAND_STATES,
  UPDATE_ERROR_CODES,
  UPDATE_ERROR_LABELS,
  UPDATE_STATE_LABELS,
  type UpdateCommandState,
} from "@/lib/shared/update-command";

describe("allowed transitions", () => {
  it("a new command can only be delivered, cancelled or superseded", () => {
    for (const to of UPDATE_COMMAND_STATES) {
      const ok = to === "DELIVERED" || to === "CANCELLED" || to === "SUPERSEDED";
      expect(canTransition("REQUESTED", to), `REQUESTED -> ${to}`).toBe(ok);
    }
  });

  it("once delivered, the agent drives it forward, may wait, may fail, and may not go back", () => {
    const forward: Array<[UpdateCommandState, UpdateCommandState]> = [
      ["DELIVERED", "CHECKING"],
      ["DELIVERED", "DOWNLOADING"],
      ["CHECKING", "DOWNLOADING"],
      ["DOWNLOADING", "VERIFYING"],
      ["VERIFYING", "INSTALLING"],
      ["INSTALLING", "SUCCESS"],
      ["DELIVERED", "SUCCESS"], // already at target
      ["CHECKING", "FAILED"],
      ["DOWNLOADING", "FAILED"],
      ["DOWNLOADING", "DOWNLOADING"], // a second attempt
      ["DOWNLOADING", "WAITING_FOR_IDLE"],
      ["VERIFYING", "WAITING_FOR_IDLE"],
      ["WAITING_FOR_IDLE", "INSTALLING"],
      ["WAITING_FOR_IDLE", "DOWNLOADING"],
    ];
    for (const [from, to] of forward) expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);

    const backward: Array<[UpdateCommandState, UpdateCommandState]> = [
      ["INSTALLING", "DOWNLOADING"],
      ["VERIFYING", "CHECKING"],
      ["DOWNLOADING", "DELIVERED"],
      ["INSTALLING", "REQUESTED"],
      ["CHECKING", "CANCELLED"], // cannot be taken back once the agent has it
      ["DOWNLOADING", "SUPERSEDED"],
    ];
    for (const [from, to] of backward) expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
  });

  it("terminal states never move again", () => {
    for (const from of TERMINAL_UPDATE_STATES) {
      for (const to of UPDATE_COMMAND_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("rollout slots are held from delivery until a terminal state", () => {
    expect(ROLLOUT_ACTIVE_STATES).toEqual([
      "DELIVERED",
      "WAITING_FOR_IDLE",
      "CHECKING",
      "DOWNLOADING",
      "VERIFYING",
      "INSTALLING",
    ]);
    expect(MAX_ACTIVE_ROLLOUT).toBe(2);
    for (const s of ROLLOUT_ACTIVE_STATES) expect(TERMINAL_UPDATE_STATES).not.toContain(s);
  });

  it("the agent reports only what it can know", () => {
    expect(AGENT_REPORTED_STATES).not.toContain("REQUESTED");
    expect(AGENT_REPORTED_STATES).not.toContain("DELIVERED");
    expect(AGENT_REPORTED_STATES).not.toContain("CANCELLED");
    expect(AGENT_REPORTED_STATES).not.toContain("SUPERSEDED");
  });
});

describe("what the screen can say", () => {
  it("has a Thai label for every state and every error code", () => {
    for (const s of UPDATE_COMMAND_STATES) expect(UPDATE_STATE_LABELS[s], s).toMatch(/[\u0E00-\u0E7F]/);
    expect(UPDATE_STATE_LABELS.OFFLINE_REQUESTED).toBe("รอเครื่องออนไลน์");
    expect(UPDATE_STATE_LABELS.ALREADY_UP_TO_DATE).toBe("เป็นรุ่นล่าสุดแล้ว");
    for (const c of UPDATE_ERROR_CODES) expect(UPDATE_ERROR_LABELS[c], c).toMatch(/[\u0E00-\u0E7F]/);
  });

  it("never mentions anything internal in a label", () => {
    const all = [...Object.values(UPDATE_STATE_LABELS), ...Object.values(UPDATE_ERROR_LABELS)].join(" ");
    expect(all).not.toMatch(/token|secret|password|GITHUB|sha256=|C:\\/i);
  });
});

describe("what is worth retrying", () => {
  it("retries the network, not a wrong file", () => {
    expect(isTransientUpdateError("DOWNLOAD_FAILED")).toBe(true);
    expect(isTransientUpdateError("CENTRAL_UNAVAILABLE")).toBe(true);
    expect(isTransientUpdateError("DIGEST_MISMATCH")).toBe(false);
    expect(isTransientUpdateError("TARGET_NOT_NEWER")).toBe(false);
    expect(isTransientUpdateError("ASSET_NAME_INVALID")).toBe(false);
  });
});
