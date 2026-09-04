/**
 * Shared plumbing for /api/agent/* routes: raw-body capture (needed for the
 * signature), authentication, uniform error shape and a lightweight rate limit.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { authenticateAgent, AgentAuthError, type AuthenticatedAgent } from "./verify";

export interface AgentRouteContext<T> {
  agent: AuthenticatedAgent;
  body: T;
  req: NextRequest;
}

export function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * In-process token bucket. It is not a cluster-wide limiter (serverless
 * instances are independent) but it caps a single misbehaving agent cheaply;
 * the durable limit is the nonce table plus per-credential auditing.
 */
const buckets = new Map<string, { tokens: number; refilledAt: number }>();
const RATE_CAPACITY = 120; // requests
const RATE_WINDOW_MS = 60_000;

function rateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: RATE_CAPACITY, refilledAt: now };
  const elapsed = now - bucket.refilledAt;
  if (elapsed > RATE_WINDOW_MS) {
    bucket.tokens = RATE_CAPACITY;
    bucket.refilledAt = now;
  }
  if (bucket.tokens <= 0) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

/** Wraps a signed agent endpoint: verifies HMAC, validates body, maps errors. */
export function withAgent<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  handler: (ctx: AgentRouteContext<z.infer<TSchema>>) => Promise<NextResponse>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const rawBody = await req.text();
    try {
      const keyId = req.headers.get("x-agent-key") ?? "anonymous";
      if (!rateLimit(keyId)) {
        return apiError(429, "RATE_LIMITED", "Too many requests");
      }

      const agent = await authenticateAgent(req, rawBody);

      let parsedJson: unknown = {};
      if (rawBody.length) {
        try {
          parsedJson = JSON.parse(rawBody);
        } catch {
          return apiError(400, "INVALID_JSON", "Request body is not valid JSON");
        }
      }

      const body = schema.safeParse(parsedJson);
      if (!body.success) {
        return apiError(422, "VALIDATION_FAILED", body.error.issues[0]?.message ?? "Invalid payload");
      }

      return await handler({ agent, body: body.data, req });
    } catch (error) {
      if (error instanceof AgentAuthError) {
        return apiError(error.status, error.code, error.message);
      }
      console.error("[agent-api] unhandled error", error);
      return apiError(500, "INTERNAL_ERROR", "Internal server error");
    }
  };
}

/** Same wrapper for unsigned endpoints (enrollment only). */
export function withUnsignedAgent<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  handler: (ctx: { body: z.infer<TSchema>; req: NextRequest }) => Promise<NextResponse>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      if (!rateLimit(`enroll:${ip}`)) {
        return apiError(429, "RATE_LIMITED", "Too many requests");
      }
      const parsed = schema.safeParse(await req.json().catch(() => ({})));
      if (!parsed.success) {
        return apiError(422, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid payload");
      }
      return await handler({ body: parsed.data, req });
    } catch (error) {
      if (error instanceof AgentAuthError) {
        return apiError(error.status, error.code, error.message);
      }
      console.error("[agent-api] unhandled error", error);
      return apiError(500, "INTERNAL_ERROR", "Internal server error");
    }
  };
}
