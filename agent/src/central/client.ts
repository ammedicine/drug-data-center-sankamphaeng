/**
 * HTTPS client for the Central API.
 *
 * Every request is signed with HMAC-SHA256 over
 *   METHOD \n path \n timestamp \n nonce \n sha256(body)
 * exactly as defined in src/lib/shared/canonical.ts, which the central server
 * uses to verify. Outbound only - the agent never listens on a port.
 */
import { randomBytes } from "node:crypto";

import {
  AGENT_HEADERS,
  buildSigningString,
  signRequest,
  type AgentConfigResponse,
  type DrugMasterRecord,
  type DrugUsageRecord,
  type HeartbeatRequest,
  type SyncUploadResponse,
} from "@shared/canonical";

import { AGENT_VERSION, type AgentCredentialFile } from "../config";
import { log } from "../logger";

export class CentralApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CentralApiError";
  }

  /** 4xx other than 408/429 will never succeed on retry. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

const RETRYABLE_NETWORK = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i;

export class CentralClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credential?: Pick<AgentCredentialFile, "keyId" | "secret">,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.credential) throw new Error("Agent credential is required for this call");

    const payload = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const signature = signRequest(
      this.credential.secret,
      buildSigningString({ method, path, timestamp, nonce, body: payload }),
    );

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        [AGENT_HEADERS.key]: this.credential.keyId,
        [AGENT_HEADERS.timestamp]: timestamp,
        [AGENT_HEADERS.nonce]: nonce,
        [AGENT_HEADERS.signature]: signature,
        [AGENT_HEADERS.version]: AGENT_VERSION,
      },
      body: payload || undefined,
    });

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      throw new CentralApiError(
        response.status,
        error?.code ?? "HTTP_ERROR",
        error?.message ?? `${response.status} ${response.statusText}`,
      );
    }

    return parsed as T;
  }

  /** Unsigned: exchanges the one-time enrollment token for a credential. */
  async enroll(input: {
    token: string;
    hostname: string;
    installationId: string;
    pcucode: string | null;
  }): Promise<{
    agentId: string;
    keyId: string;
    secret: string;
    facility: { id: string; code: string; name: string; pcucode: string };
    syncIntervalMinutes: number;
    reprocessDays: number;
  }> {
    const response = await fetch(`${this.baseUrl}/api/agent/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, agentVersion: AGENT_VERSION }),
    });
    const parsed = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | Record<string, unknown>
      | null;

    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } })?.error;
      throw new CentralApiError(
        response.status,
        error?.code ?? "HTTP_ERROR",
        error?.message ?? "Enrollment failed",
      );
    }
    return parsed as never;
  }

  heartbeat(body: HeartbeatRequest): Promise<{ ok: boolean; config: AgentConfigResponse }> {
    return this.request("POST", "/api/agent/heartbeat", body);
  }

  config(): Promise<AgentConfigResponse> {
    return this.request("GET", "/api/agent/config");
  }

  startSync(body: {
    batchRef: string;
    mode: "INITIAL" | "INCREMENTAL" | "MANUAL_RANGE" | "RETRY";
    rangeFrom: string | null;
    rangeTo: string | null;
    pcucode: string;
    recordsRead: number;
  }): Promise<{ batchId: string; resumed: boolean; uploadChunkSize: number }> {
    return this.request("POST", "/api/agent/sync/start", body);
  }

  upload(body: {
    batchRef: string;
    pcucode: string;
    sourceVersion: string | null;
    drugs?: DrugMasterRecord[];
    records: DrugUsageRecord[];
  }): Promise<SyncUploadResponse> {
    return this.request("POST", "/api/agent/sync/upload", body);
  }

  completeSync(body: {
    batchRef: string;
    status: "COMPLETED" | "FAILED" | "ABORTED";
    recordsRead: number;
    recordsSent: number;
    lastVisitDate: string | null;
    errorMessage?: string | null;
  }): Promise<{ ok: boolean }> {
    return this.request("POST", "/api/agent/sync/complete", body);
  }
}

/** Exponential backoff with jitter; gives up on permanent 4xx immediately. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number; label: string } = { label: "request" },
): Promise<T> {
  const attempts = options.attempts ?? Number(process.env.AGENT_RETRY_ATTEMPTS ?? 5);
  const baseDelay = options.baseDelayMs ?? Number(process.env.AGENT_RETRY_BASE_MS ?? 2000);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const permanent = error instanceof CentralApiError && error.permanent;
      const networkIssue = error instanceof Error && RETRYABLE_NETWORK.test(error.message);

      if (permanent || (attempt === attempts && !networkIssue)) throw error;
      if (attempt === attempts) throw error;

      const delay = Math.round(baseDelay * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      log.warn(`${options.label} failed, retrying`, {
        attempt,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((done) => setTimeout(done, delay));
    }
  }
  throw lastError;
}
