/**
 * Updating the Agent without sending someone to fifteen clinics.
 *
 * The threat this has to survive is not a bad download, it is a local one. The
 * installer runs elevated, so anything that decides *which file* runs elevated
 * is a way to become administrator on a clinic PC. Two rules follow, and
 * everything else here is a consequence of them:
 *
 *  1. This module never accepts a path, a URL, a version or a hash from
 *     anything running as the signed-in user. It asks Central itself, and
 *     Central reads the hash from GitHub's release record server side.
 *  2. It downloads into a directory the signed-in user cannot write, verifies
 *     the bytes there, and runs that same file. Nothing is executed from a
 *     place where it could be swapped between the check and the run.
 *
 * The scheduled task that calls this passes no arguments beyond the mode, so
 * there is nothing for a caller to steer.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, writeFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { MAX_UPDATE_ATTEMPTS, type UpdateCommandState, type UpdateErrorCode } from "@shared/update-command";
import { isNewerVersion } from "@shared/version";

import { AGENT_VERSION, dataDir, loadStatus } from "./config";
import { log } from "./logger";
import { UPDATE_CHECK_INTERVAL_MINUTES } from "./schedule";
import { SYSTEM_SID, UPDATE_TASK_NAME, updateTaskDefinition, updateTaskXml } from "./task-definition";
import {
  advanceUpdateCommand,
  type LocalUpdateCommand,
  type UpdaterTaskHealth,
} from "./update-command";

const run = promisify(execFile);

/** What Central says the current published installer is. */
export interface UpdateManifest {
  available: boolean;
  version?: string;
  assetName?: string;
  size?: number;
  sha256?: string | null;
  autoInstall?: boolean;
  downloadUrl?: string;
  releaseUrl?: string;
  publishedAt?: string | null;
  reason?: string;
}

export type UpdateDecision =
  | { action: "none"; reason: string }
  | { action: "blocked"; reason: string; version: string }
  | { action: "install"; version: string; sha256: string; assetName: string; size: number };

/**
 * Whether to install what Central is offering.
 *
 * Refuses to act on anything it cannot verify. A release with no recorded hash
 * is reported to the operator and left alone: HTTPS proves who served the
 * file, not that the file is the one that was published, and "install whatever
 * arrives over TLS" is how an update channel becomes an attack surface.
 */
export function decideUpdate(manifest: UpdateManifest, installed: string): UpdateDecision {
  if (!manifest.available) return { action: "none", reason: manifest.reason ?? "ไม่มีรุ่นที่เผยแพร่" };

  const version = String(manifest.version ?? "");
  if (!isNewerVersion(version, installed)) {
    // Equal, older, or unparseable. Never a downgrade, never a reinstall.
    return { action: "none", reason: `ติดตั้งรุ่น ${installed} อยู่แล้ว` };
  }
  const sha256 = String(manifest.sha256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256) || manifest.autoInstall === false) {
    return { action: "blocked", version, reason: "ไม่มีค่าตรวจสอบไฟล์ (SHA-256) จึงติดตั้งอัตโนมัติไม่ได้" };
  }
  if (!/^SDCAgent-Setup-.*\.exe$/i.test(String(manifest.assetName ?? ""))) {
    return { action: "blocked", version, reason: "ชื่อไฟล์ติดตั้งไม่ถูกต้อง" };
  }
  return {
    action: "install",
    version,
    sha256,
    assetName: String(manifest.assetName),
    size: Number(manifest.size ?? 0),
  };
}

/** Where downloads live. Created by the installer with administrators-only write. */
export function updatesDir(): string {
  return join(dataDir(), "updates");
}

export async function fetchManifest(baseUrl: string): Promise<UpdateManifest> {
  const url = new URL("/api/agent/update", baseUrl).toString();
  const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`ตรวจสอบรุ่นใหม่ไม่สำเร็จ (${response.status})`);
  return (await response.json()) as UpdateManifest;
}

/**
 * Downloads the installer and proves it is the published one.
 *
 * Written to `.part` and only renamed once the bytes are complete and the hash
 * matches, so an interrupted download leaves something that can never be
 * mistaken for an installer, and a retry simply starts again. A mismatch
 * deletes the file rather than leaving it to be found later.
 */
export async function downloadVerified(input: {
  baseUrl: string;
  version: string;
  assetName: string;
  sha256: string;
  size: number;
  /** always the fixed proxy route; a parameter only so tests can point elsewhere */
  downloadUrl?: string;
}): Promise<string> {
  const folder = join(updatesDir(), input.version);
  await mkdir(folder, { recursive: true });
  const target = join(folder, input.assetName);
  const partial = `${target}.part`;

  // A previous run may have finished this already; verify rather than trust.
  try {
    if ((await stat(target)).isFile() && (await sha256Of(target)) === input.sha256) {
      log.info("มีไฟล์ติดตั้งที่ตรวจแล้วอยู่ก่อน", { version: input.version });
      return target;
    }
    await rm(target, { force: true });
  } catch {
    /* not there yet, which is the normal case */
  }

  await rm(partial, { force: true });
  const url = new URL(input.downloadUrl ?? "/download/agent", input.baseUrl).toString();
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`ดาวน์โหลดไม่สำเร็จ (${response.status})`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));

  const bytes = (await stat(partial)).size;
  if (input.size > 0 && bytes !== input.size) {
    await rm(partial, { force: true });
    throw new Error(`ขนาดไฟล์ไม่ตรง (ได้ ${bytes} ต้องการ ${input.size})`);
  }

  const digest = await sha256Of(partial);
  if (digest !== input.sha256) {
    // Never leave a file that failed verification anywhere it could be run.
    await rm(partial, { force: true });
    throw new Error("ค่าตรวจสอบไฟล์ (SHA-256) ไม่ตรงกับที่ประกาศไว้ ยกเลิกการติดตั้ง");
  }

  await rename(partial, target);
  log.info("ดาวน์โหลดและตรวจไฟล์ติดตั้งแล้ว", { version: input.version, bytes });
  return target;
}

/** Streamed, because the installer is forty megabytes. */
export async function sha256Of(path: string): Promise<string> {
  const digest = createHash("sha256");
  await pipeline(createReadStream(path), digest);
  return digest.digest("hex");
}

/** True while a sync is doing something it would be rude to interrupt. */
export function syncIsBusy(): boolean {
  const phase = loadStatus().syncPhase;
  return phase === "READING" || phase === "UPLOADING" || phase === "VERIFYING";
}

/**
 * Runs the installer.
 *
 * /VERYSILENT is the mode that has actually been proven on this installer.
 * /SUPPRESSMSGBOXES is deliberately absent: it turns Inno's pre-flight
 * questions into an automatic Cancel, which is how a silent install of 1.1.5
 * failed three times in a row while reporting only exit code 2.
 */
export async function installUpdate(installerPath: string, version: string): Promise<void> {
  const logPath = join(dataDir(), "logs", `update-${version}.log`);
  log.info("กำลังติดตั้งรุ่นใหม่", { version });
  try {
    await run(installerPath, ["/VERYSILENT", "/NORESTART", `/LOG=${logPath}`], {
      timeout: 15 * 60_000,
      windowsHide: true,
    });
  } catch (error) {
    // execFile puts the exit code on the error, not in its message, so an
    // installer that refused told us only "Command failed". Inno's codes are
    // the difference between a question that answered itself (2), a file still
    // in use (5) and a machine that genuinely cannot take this build - and
    // whoever reads this log will not have the machine in front of them.
    const code = (error as { code?: number | string }).code ?? "unknown";
    log.error("ตัวติดตั้งจบด้วยรหัสผิดพลาด", { version, exitCode: code, logPath });
    throw new Error(`ตัวติดตั้งจบด้วยรหัส ${code}`);
  }
  log.info("ติดตั้งรุ่นใหม่แล้ว", { version, logPath, exitCode: 0 });
}

/* ====================================================== the update engine */

/**
 * One state machine for both ways an update can start.
 *
 * The scheduled task asks "is there anything newer?"; the centre's command
 * says "install this one". Both arrive here, and from here on there is no
 * difference: the same manifest check, the same size and SHA-256 gate, the
 * same wait for an idle sync, the same installer with the same flags. Two
 * implementations would be two places for the next bug.
 *
 * Every step is written to the durable command file before it happens, so a
 * PC switched off mid-download tells the next run exactly where it stopped,
 * and the worker can report the same file to the centre.
 */
export type UpdateTrigger = "scheduled" | "command";

export interface UpdateEngineResult {
  /** what the run concluded, in the command vocabulary */
  state: UpdateCommandState | "NONE" | "BLOCKED";
  detail: string;
  errorCode?: UpdateErrorCode | null;
  version?: string | null;
  installed?: boolean;
}

function classifyDownloadFailure(message: string): UpdateErrorCode {
  if (/SHA-256/.test(message)) return "DIGEST_MISMATCH";
  if (/ขนาดไฟล์/.test(message)) return "SIZE_MISMATCH";
  return "DOWNLOAD_FAILED";
}

export async function runUpdateEngine(input: {
  baseUrl: string;
  trigger: UpdateTrigger;
  /** the held command, when the trigger is "command" */
  command: LocalUpdateCommand | null;
  force?: boolean;
  /** injectable for tests */
  fetchManifestFn?: typeof fetchManifest;
  downloadFn?: typeof downloadVerified;
  installFn?: typeof installUpdate;
  busyFn?: typeof syncIsBusy;
}): Promise<UpdateEngineResult> {
  const getManifest = input.fetchManifestFn ?? fetchManifest;
  const download = input.downloadFn ?? downloadVerified;
  const install = input.installFn ?? installUpdate;
  const busy = input.busyFn ?? syncIsBusy;
  const command = input.trigger === "command" ? input.command : null;

  if (command) advanceUpdateCommand("CHECKING");

  let manifest: UpdateManifest;
  try {
    manifest = await getManifest(input.baseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command) {
      // Transient: the centre will be there next time. The command stays
      // open and the next run tries again from CHECKING.
      advanceUpdateCommand("DELIVERED");
    }
    return { state: "FAILED", detail: message, errorCode: "CENTRAL_UNAVAILABLE" };
  }

  const decision = decideUpdate(manifest, AGENT_VERSION);

  if (decision.action === "none") {
    if (command) {
      // The centre asked for something this build already is, or nothing is
      // published above it. Either way there is nothing to install.
      advanceUpdateCommand("SUCCESS");
    }
    return { state: "NONE", detail: decision.reason, version: manifest.version ?? AGENT_VERSION };
  }

  if (decision.action === "blocked") {
    if (command) {
      advanceUpdateCommand("FAILED", {
        errorCode: manifest.sha256 ? "ASSET_NAME_INVALID" : "DIGEST_MISSING",
        errorMessage: decision.reason,
      });
    }
    return { state: "BLOCKED", detail: decision.reason, version: decision.version };
  }

  // A command pins one release. If the centre now publishes something else,
  // installing "whatever is latest" is not what the operator approved.
  if (command) {
    if (decision.version !== command.targetVersion || decision.sha256 !== command.sha256.toLowerCase()) {
      advanceUpdateCommand("FAILED", {
        errorCode: "TARGET_NOT_AVAILABLE",
        errorMessage: `ศูนย์กลางเผยแพร่รุ่น ${decision.version} แต่คำสั่งระบุรุ่น ${command.targetVersion}`,
      });
      return {
        state: "FAILED",
        detail: `target ${command.targetVersion} is no longer what the centre publishes (${decision.version})`,
        errorCode: "TARGET_NOT_AVAILABLE",
        version: decision.version,
      };
    }
  }

  if (busy() && !input.force) {
    if (command) advanceUpdateCommand("WAITING_FOR_IDLE");
    return { state: "WAITING_FOR_IDLE", detail: "รอการซิงก์ปัจจุบันเสร็จก่อนติดตั้ง", version: decision.version };
  }

  if (command) advanceUpdateCommand("DOWNLOADING", { attempt: true });
  let installer: string;
  try {
    installer = await download({
      baseUrl: input.baseUrl,
      version: decision.version,
      assetName: decision.assetName,
      sha256: decision.sha256,
      size: decision.size,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = classifyDownloadFailure(message);
    if (command) {
      if (code === "DOWNLOAD_FAILED" && command.attempts + 1 < MAX_UPDATE_ATTEMPTS) {
        // Network, most likely. Keep the command; try again next run.
        advanceUpdateCommand("DELIVERED");
      } else {
        // A wrong digest is not going to become right by trying again.
        advanceUpdateCommand("FAILED", { errorCode: code, errorMessage: message });
      }
    }
    return { state: "FAILED", detail: message, errorCode: code, version: decision.version };
  }

  if (command) advanceUpdateCommand("VERIFYING");
  // The download already verified size and digest before renaming into
  // place; verifying again here proves the file on disk is still that file,
  // in a directory the signed-in user cannot write.
  const digest = await sha256Of(installer);
  if (digest !== decision.sha256) {
    await rm(installer, { force: true });
    if (command) advanceUpdateCommand("FAILED", { errorCode: "DIGEST_MISMATCH", errorMessage: "ไฟล์บนดิสก์ไม่ตรงกับค่าตรวจสอบ" });
    return { state: "FAILED", detail: "installer on disk no longer matches its digest", errorCode: "DIGEST_MISMATCH", version: decision.version };
  }

  // Idle is re-checked right before the installer runs: a sync may have
  // started during a slow download.
  if (busy() && !input.force) {
    if (command) advanceUpdateCommand("WAITING_FOR_IDLE");
    return { state: "WAITING_FOR_IDLE", detail: "รอการซิงก์ปัจจุบันเสร็จก่อนติดตั้ง", version: decision.version };
  }

  if (command) advanceUpdateCommand("INSTALLING");
  try {
    await install(installer, decision.version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command) advanceUpdateCommand("FAILED", { errorCode: "INSTALLER_FAILED", errorMessage: message });
    return { state: "FAILED", detail: message, errorCode: "INSTALLER_FAILED", version: decision.version };
  }
  // SUCCESS is not written here on purpose: the installer has just replaced
  // this program. The new build's first start reads INSTALLING, sees its own
  // version at the target, and records SUCCESS - the state that survives the
  // restart is the one the restart proves.
  return { state: "INSTALLING", detail: `ติดตั้งรุ่น ${decision.version} แล้ว รอเริ่มโปรแกรมใหม่`, version: decision.version, installed: true };
}

/* ================================================= the task, from inside */

const TASK_HEALTH_TIMEOUT_MS = 20_000;

/** True when this process runs as LocalSystem - the only context that may touch the task. */
export function runningAsSystem(): boolean {
  const name = String(process.env.USERNAME ?? "").toUpperCase();
  return name === "SYSTEM" || name.endsWith("$");
}

/**
 * Reads the Agent's own scheduled task, as SYSTEM sees it.
 *
 * A standard user cannot see a SYSTEM task at all, so this only runs from
 * the task itself. What it finds is written to updater-task.json for the
 * worker to report, so the fleet screen can say "this machine has no update
 * task" instead of the machine just never updating.
 */
export async function readUpdaterTaskHealth(): Promise<UpdaterTaskHealth> {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout } = await run("schtasks", ["/Query", "/TN", UPDATE_TASK_NAME, "/XML"], {
      timeout: TASK_HEALTH_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    });
    const xml = String(stdout);
    const pick = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;
    let lastRun: string | null = null;
    let lastResult: string | null = null;
    try {
      const { stdout: list } = await run(
        "schtasks",
        ["/Query", "/TN", UPDATE_TASK_NAME, "/FO", "LIST", "/V"],
        { timeout: TASK_HEALTH_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      );
      lastRun = /Last Run Time:\s*(.+)/.exec(String(list))?.[1]?.trim() ?? null;
      lastResult = /Last Result:\s*(.+)/.exec(String(list))?.[1]?.trim() ?? null;
    } catch {
      /* the XML alone is enough to judge the definition */
    }
    const start = pick("StartBoundary");
    return {
      present: true,
      cadence: pick("Interval"),
      runAs: pick("UserId"),
      lastRun,
      lastResult,
      startWhenAvailable: pick("StartWhenAvailable") === "true",
      allowOnBatteries: pick("DisallowStartIfOnBatteries") === "false",
      slot: start ? start.slice(11, 16) : null,
      checkedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      present: false,
      cadence: null,
      runAs: null,
      lastRun: null,
      lastResult: null,
      startWhenAvailable: null,
      allowOnBatteries: null,
      slot: null,
      checkedAt,
      error: message.slice(0, 200),
    };
  }
}

/**
 * Whether the task as found is the task v1.1.10 wants.
 *
 * Pure, so the repair decision can be tested without a Task Scheduler.
 */
export function updaterTaskNeedsRepair(health: UpdaterTaskHealth): string | null {
  if (!health.present) return "task missing";
  if (health.cadence !== `PT${UPDATE_CHECK_INTERVAL_MINUTES}M`) return `cadence ${health.cadence}`;
  if (health.runAs !== SYSTEM_SID) return `run-as ${health.runAs}`;
  if (health.startWhenAvailable !== true) return "missed triggers are not caught up";
  if (health.allowOnBatteries !== true) return "does not start on battery";
  return null;
}

/**
 * Re-registers the Agent's own task from the canonical definition.
 *
 * Only as SYSTEM, only by its fixed name, and only when the existing task
 * (if any) points at this installation - a task of that name belonging to
 * some other program is left alone and reported, not overwritten.
 */
export async function repairUpdaterTask(input: {
  appDir: string;
  identity: string;
  health: UpdaterTaskHealth;
}): Promise<{ repaired: boolean; reason: string }> {
  const reason = updaterTaskNeedsRepair(input.health);
  if (!reason) return { repaired: false, reason: "healthy" };
  if (!runningAsSystem()) return { repaired: false, reason: `${reason}; not SYSTEM, cannot repair` };

  if (input.health.present) {
    // Ownership: the action must be our runtime under our install directory.
    try {
      const { stdout } = await run("schtasks", ["/Query", "/TN", UPDATE_TASK_NAME, "/XML"], {
        timeout: TASK_HEALTH_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
      });
      const command = /<Command>([^<]*)<\/Command>/.exec(String(stdout))?.[1] ?? "";
      const ours = command.toLowerCase().startsWith(input.appDir.replace(/[\\/]+$/, "").toLowerCase());
      if (!ours) return { repaired: false, reason: `${reason}; task belongs to ${command || "unknown"}, left alone` };
    } catch {
      return { repaired: false, reason: `${reason}; could not read existing task` };
    }
  }

  const xml = updateTaskXml(updateTaskDefinition({ appDir: input.appDir, identity: input.identity }));
  const file = join(dataDir(), "updater-task.xml");
  writeFileSync(file, "\uFEFF" + xml, { encoding: "utf16le" });
  try {
    await run("schtasks", ["/Create", "/TN", UPDATE_TASK_NAME, "/XML", file, "/F"], {
      timeout: TASK_HEALTH_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
    });
    log.info("ซ่อมงานตรวจรุ่นใหม่ของตัวเองแล้ว", { reason });
    return { repaired: true, reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("ซ่อมงานตรวจรุ่นใหม่ไม่สำเร็จ", { reason, error: message.slice(0, 200) });
    return { repaired: false, reason: `${reason}; repair failed: ${message.slice(0, 120)}` };
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Asks Task Scheduler to run the update task now.
 *
 * Works when the task's security descriptor lets the signed-in user run it,
 * which the v1.1.10 installer arranges. On an installation that did not, it
 * fails quietly and the task's own 30-minute schedule picks the command up.
 */
export async function requestUpdateTaskRun(): Promise<boolean> {
  try {
    await run("schtasks", ["/Run", "/TN", UPDATE_TASK_NAME], { timeout: 15_000, windowsHide: true });
    log.info("ขอให้งานตรวจรุ่นใหม่ทำงานทันที");
    return true;
  } catch (error) {
    log.debug("could not start the update task on demand; the schedule will", {
      error: error instanceof Error ? error.message.slice(0, 120) : String(error),
    });
    return false;
  }
}

/**
 * Brings the tray back for the signed-in person after an unattended install.
 *
 * The installer runs `[Run]` with skipifsilent, and under SYSTEM there is no
 * "original user" to run it as anyway - so after a silent install the tray
 * the installer closed simply stayed closed, and with it the worker, until
 * somebody next signed in. Here the console user is looked up and a one-shot
 * interactive task starts the program in their session, then removes itself.
 * Best effort: a failure is logged and the next logon still starts it.
 */
export async function relaunchTrayForConsoleUser(appDir: string): Promise<boolean> {
  const exe = join(appDir, "SDCAgent.exe");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$user = (Get-CimInstance Win32_ComputerSystem).UserName",
    "if (-not $user) { Write-Output 'no console user'; exit 2 }",
    "$name = 'SDCAgentRelaunch'",
    `$action = New-ScheduledTaskAction -Execute '${exe.replace(/'/g, "''")}'`,
    "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null",
    "Start-ScheduledTask -TaskName $name",
    "Start-Sleep -Seconds 3",
    "Unregister-ScheduledTask -TaskName $name -Confirm:$false",
    "Write-Output \"relaunched for $user\"",
  ].join("; ");
  try {
    const { stdout } = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 60_000, windowsHide: true, encoding: "utf8" },
    );
    log.info("เปิดหน้าจอให้ผู้ใช้ที่ล็อกอินอยู่แล้ว", { detail: String(stdout).trim().slice(0, 120) });
    return true;
  } catch (error) {
    log.warn("เปิดหน้าจอให้ผู้ใช้ไม่สำเร็จ จะเปิดเองเมื่อล็อกอินครั้งถัดไป", {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
    return false;
  }
}
