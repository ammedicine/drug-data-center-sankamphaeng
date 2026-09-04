/**
 * Facility / agent / user administration queries.
 * Callers must have passed requireSuperAdmin() or an explicit facility scope.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents, auditLogs, facilities, users } from "@/lib/db/schema";
import type { UserRole } from "@/lib/db/schema";

export interface FacilityListRow {
  id: string;
  code: string;
  jhcisPcucode: string;
  name: string;
  province: string | null;
  district: string | null;
  subdistrict: string | null;
  isActive: boolean;
  agentCount: number;
  activeUsers: number;
  lastHeartbeatAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
}

export async function listFacilities(scopeIds: string[] | null): Promise<FacilityListRow[]> {
  const rows = await db
    .select({
      id: facilities.id,
      code: facilities.code,
      jhcisPcucode: facilities.jhcisPcucode,
      name: facilities.name,
      province: facilities.province,
      district: facilities.district,
      subdistrict: facilities.subdistrict,
      isActive: facilities.isActive,
      agentCount: sql<number>`(SELECT COUNT(*) FROM ${agents} a WHERE a.facility_id = ${facilities.id})`,
      activeUsers: sql<number>`(SELECT COUNT(*) FROM ${users} u WHERE u.facility_id = ${facilities.id} AND u.is_active = 1)`,
      lastHeartbeatAt: sql<Date | null>`(SELECT MAX(a.last_heartbeat_at) FROM ${agents} a WHERE a.facility_id = ${facilities.id})`,
      lastSuccessfulSyncAt: sql<Date | null>`(SELECT MAX(a.last_successful_sync_at) FROM ${agents} a WHERE a.facility_id = ${facilities.id})`,
    })
    .from(facilities)
    .where(scopeIds ? inArray(facilities.id, scopeIds) : undefined)
    .orderBy(facilities.code);

  return rows.map((r) => ({
    ...r,
    agentCount: Number(r.agentCount ?? 0),
    activeUsers: Number(r.activeUsers ?? 0),
    lastHeartbeatAt: r.lastHeartbeatAt ? new Date(r.lastHeartbeatAt) : null,
    lastSuccessfulSyncAt: r.lastSuccessfulSyncAt ? new Date(r.lastSuccessfulSyncAt) : null,
  }));
}

/** Minimal list used by filter dropdowns. */
export async function listFacilityOptions(
  scopeIds: string[] | null,
): Promise<Array<{ id: string; code: string; name: string }>> {
  return db
    .select({ id: facilities.id, code: facilities.code, name: facilities.name })
    .from(facilities)
    .where(
      scopeIds
        ? and(inArray(facilities.id, scopeIds), eq(facilities.isActive, true))
        : eq(facilities.isActive, true),
    )
    .orderBy(facilities.code);
}

export interface UserListRow {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  facilityId: string | null;
  facilityName: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
}

export async function listUsers(scopeIds: string[] | null): Promise<UserListRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      facilityId: users.facilityId,
      facilityName: facilities.name,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .where(scopeIds ? inArray(users.facilityId, scopeIds) : undefined)
    .orderBy(users.email);

  return rows;
}

export interface AuditRow {
  id: number;
  actorType: string;
  actorLabel: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  facilityName: string | null;
  ip: string | null;
  createdAt: Date;
}

export async function listAuditLogs(
  scopeIds: string[] | null,
  limit = 100,
): Promise<AuditRow[]> {
  return db
    .select({
      id: auditLogs.id,
      actorType: auditLogs.actorType,
      actorLabel: auditLogs.actorLabel,
      action: auditLogs.action,
      resource: auditLogs.resource,
      resourceId: auditLogs.resourceId,
      facilityName: facilities.name,
      ip: auditLogs.ip,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(facilities, eq(facilities.id, auditLogs.facilityId))
    .where(scopeIds ? inArray(auditLogs.facilityId, scopeIds) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
