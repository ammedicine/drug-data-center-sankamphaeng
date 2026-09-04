/**
 * Minimal file + console logger.
 * Never log: JHCIS password, central secret, enrollment token, or any patient
 * identifier (JHCIS_INTEGRATION section 24).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = "[redacted]";
const SECRET_KEYS = /(password|secret|token|authorization|signature)/i;

function threshold(): number {
  return LEVELS[(process.env.AGENT_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
}

function logDir(): string {
  const dir = resolve(process.env.AGENT_DATA_DIR ?? "./data", "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Recursively masks anything that looks like a credential before it is written. */
export function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? REDACTED : redact(item);
  }
  return out;
}

function write(level: Level, message: string, meta?: unknown): void {
  if (LEVELS[level] < threshold()) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { meta: redact(meta) } : {}),
  };

  const line = JSON.stringify(entry);
  const consoleLine = `${entry.ts} ${level.toUpperCase().padEnd(5)} ${message}${
    meta !== undefined ? ` ${JSON.stringify(redact(meta))}` : ""
  }`;

  if (level === "error") console.error(consoleLine);
  else if (level === "warn") console.warn(consoleLine);
  else console.log(consoleLine);

  try {
    const file = resolve(logDir(), `agent-${new Date().toISOString().slice(0, 10)}.log`);
    appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    // Logging must never break the sync run.
  }
}

export const log = {
  debug: (message: string, meta?: unknown) => write("debug", message, meta),
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
};
