/**
 * The updates directory grants normal users READ, never write.
 *
 * The hand-off result the SYSTEM helper writes lives in the administrators-only
 * updates directory. v1.1.15 lets the user-session worker READ it (to report
 * why an install failed) by granting BUILTIN\Users (RX) - read and traverse -
 * and nothing more. The lock the original ACL exists for is WRITE: a normal
 * user must not be able to swap an installer, the node copy the helper runs,
 * or any SYSTEM-executed artifact after its hash was checked. This test runs
 * the exact icacls grants the installer ships, against a directory the test
 * owns (no elevation needed), and proves Users can read but cannot write,
 * modify or delete, while Administrators and SYSTEM keep full control.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The grant flags the installer applies to %ProgramData%\SDCAgent\updates,
// read straight from the shipped script so the test cannot drift from it.
function installerUpdatesGrants(): string[] {
  const iss = readFileSync(resolve(process.cwd(), "agent", "installer", "sdc-agent.iss"), "utf8");
  const line = iss.split(/\r?\n/).find((l) => l.includes("/inheritance:r") && l.includes("icacls") === false && l.includes("/grant"));
  // The RunTool argument string is a Pascal-quoted literal; pull the /grant parts.
  const src = line ?? iss;
  return [...src.matchAll(/\/grant \*(S-1-5-[0-9-]+):\(OI\)\(CI\)\(?([A-Z]+)\)?/g)].map((m) => `*${m[1]}:(OI)(CI)(${m[2]})`);
}

describe("updates directory ACL", () => {
  it("grants Users read-only, and keeps SYSTEM/Administrators in full control", () => {
    if (process.platform !== "win32") return;
    const grants = installerUpdatesGrants();
    // Sanity: we found the three grants (Admins F, SYSTEM F, Users RX).
    expect(grants).toContain("*S-1-5-32-544:(OI)(CI)(F)");
    expect(grants).toContain("*S-1-5-18:(OI)(CI)(F)");
    expect(grants).toContain("*S-1-5-32-545:(OI)(CI)(RX)");

    const dir = mkdtempSync(resolve(tmpdir(), "sdc-acl-"));
    try {
      execFileSync("icacls", [dir, "/inheritance:r", ...grants.flatMap((g) => ["/grant", g])], {
        windowsHide: true,
        encoding: "utf8",
      });
      const acl = execFileSync("icacls", [dir], { windowsHide: true, encoding: "utf8" });
      const users = acl.split(/\r?\n/).find((l) => /\\Users:/i.test(l)) ?? "";
      // Users: read & traverse only. Never write, modify, delete or full.
      expect(users).toMatch(/\(RX\)/);
      expect(users).not.toMatch(/\((F|M|W|D)\)/);
      // SYSTEM and Administrators keep full control.
      expect(acl).toMatch(/NT AUTHORITY\\SYSTEM:\(OI\)\(CI\)\(F\)/i);
      expect(acl).toMatch(/BUILTIN\\Administrators:\(OI\)\(CI\)\(F\)/i);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
