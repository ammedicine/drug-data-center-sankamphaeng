import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";

export type AuditAction =
  | "LOGIN"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "USER_CREATE"
  | "USER_UPDATE"
  | "USER_DISABLE"
  | "USER_DELETE"
  | "USER_PASSWORD_RESET"
  | "FACILITY_CREATE"
  | "FACILITY_UPDATE"
  | "FACILITY_DISABLE"
  | "AGENT_CREATE"
  | "AGENT_UPDATE"
  | "AGENT_ENROLL"
  | "AGENT_TOKEN_ISSUE"
  | "AGENT_REVOKE"
  | "AGENT_DELETE"
  | "FACILITY_DATA_PURGE"
  | "AGENT_SYNC_PAUSED"
  | "AGENT_SYNC_RESUMED"
  | "SYNC_START"
  | "SYNC_COMPLETE"
  | "SYNC_FAILED"
  | "REPORT_EXPORT"
  | "PERMISSION_CHANGE";

interface AuditInput {
  actorType: "USER" | "AGENT" | "SYSTEM";
  actorId?: string | null;
  actorLabel?: string | null;
  action: AuditAction;
  resource: string;
  resourceId?: string | null;
  facilityId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Audit writes must never break the operation they describe, so failures are
 * swallowed after being logged to the server console.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ?? null,
      facilityId: input.facilityId ?? null,
      ip: input.ip ?? null,
      metadata: input.metadata ?? null,
    });
  } catch (error) {
    console.error("[audit] failed to write audit log", { action: input.action, error });
  }
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return headers.get("x-real-ip");
}
