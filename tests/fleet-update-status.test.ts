/**
 * The fleet update column must show current software state, not stale history.
 *
 * The bug this pins down: 05957 finished a command to install 1.1.11 that
 * FAILED (2026-09-14), then reached 1.1.14 and 1.1.15 by other means, and the
 * screen still read "อัปเดตไม่สำเร็จ" in red for a healthy, current machine.
 * A failed command is only the current problem while the running version has
 * not yet reached what that command was installing; once it has, the failure
 * is history, shown as a secondary note, never as the machine's state.
 */
import { describe, expect, it } from "vitest";

import { deriveUpdateStatus, type FleetUpdateInput } from "@/lib/shared/fleet-update-status";

const base: FleetUpdateInput = {
  status: "ONLINE",
  version: "1.1.15",
  latestVersion: "1.1.15",
  updateAvailable: false,
  supportsRemoteUpdate: true,
  command: null,
};
const cmd = (over: Partial<NonNullable<FleetUpdateInput["command"]>>): NonNullable<FleetUpdateInput["command"]> => ({
  status: "SUCCESS",
  targetVersion: "1.1.15",
  terminal: true,
  errorCode: null,
  completedAtLabel: null,
  ...over,
});

describe("current state wins over a superseded failure", () => {
  it("A. old FAILED 1.1.11, now on 1.1.15 with a newer SUCCESS, latest 1.1.15 -> latest, not failed", () => {
    const s = deriveUpdateStatus({ ...base, command: cmd({ status: "SUCCESS", targetVersion: "1.1.15" }) });
    expect(s.tone).toBe("ok");
    expect(s.text).toContain("เป็นรุ่นล่าสุด");
    expect(s.text).not.toContain("ไม่สำเร็จ");
  });

  it("B. old FAILED 1.1.11 is the newest command, now on 1.1.15, latest 1.1.15 -> latest, failure kept as history", () => {
    const s = deriveUpdateStatus({
      ...base,
      command: cmd({ status: "FAILED", targetVersion: "1.1.11", terminal: true, errorCode: "INSTALLER_FAILED" }),
    });
    expect(s.tone).toBe("ok");
    expect(s.text).toContain("เป็นรุ่นล่าสุด");
    expect(s.text).not.toContain("ไม่สำเร็จ");
    // The failure is not lost - it is available as a secondary history note.
    expect(s.history).toContain("1.1.11");
  });

  it("C. an active INSTALLING command is the current state", () => {
    const s = deriveUpdateStatus({
      ...base,
      version: "1.1.15",
      latestVersion: "1.1.16",
      updateAvailable: true,
      command: cmd({ status: "INSTALLING", targetVersion: "1.1.16", terminal: false }),
    });
    expect(s.tone).toBe("warn");
    expect(s.text).toContain("1.1.16");
    expect(s.history).toBeUndefined();
  });

  it("D. newest command FAILED for a target still ahead of current -> failed", () => {
    const s = deriveUpdateStatus({
      ...base,
      version: "1.1.15",
      latestVersion: "1.1.16",
      updateAvailable: true,
      command: cmd({ status: "FAILED", targetVersion: "1.1.16", terminal: true, errorCode: "DIGEST_MISMATCH" }),
    });
    expect(s.tone).toBe("danger");
    expect(s.text).toContain("ไม่สำเร็จ");
  });

  it("E. FAILED 1.1.14 then SUCCESS 1.1.15 (newest), now on 1.1.15 -> latest/success", () => {
    const s = deriveUpdateStatus({ ...base, command: cmd({ status: "SUCCESS", targetVersion: "1.1.15" }) });
    expect(s.tone).toBe("ok");
    expect(s.text).not.toContain("ไม่สำเร็จ");
  });

  it("F. offline old agent with a newer version available is not reported as up to date", () => {
    const s = deriveUpdateStatus({
      status: "OFFLINE",
      version: "1.1.10",
      latestVersion: "1.1.15",
      updateAvailable: true,
      supportsRemoteUpdate: true,
      command: null,
    });
    expect(s.tone).toBe("warn");
    expect(s.text).toContain("มีรุ่น");
    expect(s.text).not.toContain("สำเร็จ");
  });

  it("a legacy build that cannot take a command says so, not a false failure", () => {
    const s = deriveUpdateStatus({
      status: "ONLINE",
      version: "1.1.8",
      latestVersion: "1.1.15",
      updateAvailable: true,
      supportsRemoteUpdate: false,
      command: null,
    });
    expect(s.tone).toBe("muted");
    expect(s.text).toContain("30");
  });

  it("an offline machine with a REQUESTED command reads as waiting for the machine", () => {
    const s = deriveUpdateStatus({
      ...base,
      status: "OFFLINE",
      version: "1.1.14",
      latestVersion: "1.1.15",
      updateAvailable: true,
      command: cmd({ status: "REQUESTED", targetVersion: "1.1.15", terminal: false }),
    });
    expect(s.tone).toBe("warn");
    expect(s.text).toContain("รอเครื่องออนไลน์");
  });
});
