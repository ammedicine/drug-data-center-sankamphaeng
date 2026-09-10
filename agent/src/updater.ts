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
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { isNewerVersion } from "@shared/version";

import { dataDir, loadStatus } from "./config";
import { log } from "./logger";

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
