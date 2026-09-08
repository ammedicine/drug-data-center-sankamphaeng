/**
 * Central database schema (TiDB Cloud / MySQL compatible).
 *
 * Rules (see CLAUDE.md):
 * - every facility-scoped table MUST carry facility_id and index it first
 * - no patient-identifying columns are ever stored here (PROJECT_SPEC section 20)
 * - drug_usage is the high-volume table: keep it narrow and indexed for aggregation
 */
import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  date,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const id = (name: string) => varchar(name, { length: 30 });
const createdAt = timestamp("created_at").notNull().defaultNow();
const updatedAt = timestamp("updated_at").notNull().defaultNow().onUpdateNow();

/**
 * SUPER_ADMIN   เห็นทุกสถานบริการ + จัดการได้ทุกอย่าง
 * ADMIN         เห็นทุกสถานบริการ แต่ดูอย่างเดียว (ไม่จัดการผู้ใช้/agent/facility)
 * FACILITY_ADMIN เห็นเฉพาะสถานบริการตัวเอง + จัดการผู้ใช้ในสถานบริการตัวเอง
 * USER          เห็นเฉพาะสถานบริการตัวเอง
 */
export const USER_ROLES = ["SUPER_ADMIN", "ADMIN", "FACILITY_ADMIN", "USER"] as const;
export const AGENT_STATUSES = ["ONLINE", "OFFLINE", "SYNCING", "ERROR", "DISABLED"] as const;
export const BATCH_STATUSES = ["STARTED", "UPLOADING", "COMPLETED", "FAILED", "ABORTED"] as const;
export const SYNC_MODES = ["INITIAL", "INCREMENTAL", "MANUAL_RANGE", "RETRY"] as const;

/* ------------------------------------------------------------------ users */

export const users = mysqlTable(
  "users",
  {
    id: id("id").primaryKey(),
    /** login name chosen at registration; email stays optional */
    username: varchar("username", { length: 60 }),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    /** ตำแหน่ง เช่น พยาบาลวิชาชีพ, เจ้าพนักงานเภสัชกรรม */
    position: varchar("position", { length: 120 }),
    role: mysqlEnum("role", USER_ROLES).notNull().default("USER"),
    /** null for SUPER_ADMIN; every other role is bound to exactly one facility */
    facilityId: id("facility_id"),
    /** self-registered accounts start inactive and wait for approval */
    isActive: boolean("is_active").notNull().default(true),
    approvedAt: datetime("approved_at"),
    approvedByUserId: id("approved_by_user_id"),
    lastLoginAt: datetime("last_login_at"),
    /** bumped on password change / forced logout: invalidates issued sessions */
    sessionEpoch: int("session_epoch").notNull().default(1),
    createdAt,
    updatedAt,
  },
  (t) => ({
    emailUq: uniqueIndex("users_email_uq").on(t.email),
    usernameUq: uniqueIndex("users_username_uq").on(t.username),
    facilityIdx: index("users_facility_idx").on(t.facilityId, t.isActive),
  }),
);

/* ------------------------------------------------------------- facilities */

export const facilities = mysqlTable(
  "facilities",
  {
    id: id("id").primaryKey(),
    /** internal code shown in the UI */
    code: varchar("code", { length: 20 }).notNull(),
    /** the pcucode owned by this facility's JHCISDB (e.g. 05957) */
    jhcisPcucode: char("jhcis_pcucode", { length: 5 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    province: varchar("province", { length: 100 }),
    district: varchar("district", { length: 100 }),
    subdistrict: varchar("subdistrict", { length: 100 }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (t) => ({
    codeUq: uniqueIndex("facilities_code_uq").on(t.code),
    pcucodeUq: uniqueIndex("facilities_pcucode_uq").on(t.jhcisPcucode),
  }),
);

/** optional extra facility grants (a user may be granted read access elsewhere) */
export const facilityUsers = mysqlTable(
  "facility_users",
  {
    facilityId: id("facility_id").notNull(),
    userId: id("user_id").notNull(),
    canManage: boolean("can_manage").notNull().default(false),
    createdAt,
  },
  (t) => ({
    pk: primaryKey({ columns: [t.facilityId, t.userId] }),
    userIdx: index("facility_users_user_idx").on(t.userId),
  }),
);

/* ----------------------------------------------------------------- agents */

export const agents = mysqlTable(
  "agents",
  {
    id: id("id").primaryKey(),
    facilityId: id("facility_id").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    status: mysqlEnum("status", AGENT_STATUSES).notNull().default("OFFLINE"),
    version: varchar("version", { length: 40 }),
    installationId: varchar("installation_id", { length: 64 }),
    hostname: varchar("hostname", { length: 120 }),
    /**
     * The account that enrolled this agent. An agent is a machine acting for
     * one person at one สถานบริการ, so the listing can show each user their
     * own rather than everyone's.
     */
    ownerUserId: id("owner_user_id"),
    /**
     * The network card the agent actually reaches Central through - resolved
     * from the local address of a real connection, not the first entry in the
     * adapter list, so a Bluetooth or virtual adapter is never reported as the
     * machine's identity.
     */
    macAddress: varchar("mac_address", { length: 32 }),
    ipAddress: varchar("ip_address", { length: 45 }),
    networkInterface: varchar("network_interface", { length: 80 }),
    /** reported by the agent from office.offid, validated against the facility */
    jhcisPcucode: char("jhcis_pcucode", { length: 5 }),
    jhcisVersion: varchar("jhcis_version", { length: 40 }),
    mysqlVersion: varchar("mysql_version", { length: 40 }),
    /** SchemaInspector compatibility report (no credentials, no patient data) */
    schemaReport: json("schema_report"),
    syncIntervalMinutes: int("sync_interval_minutes").notNull().default(60),
    /** how many days back an incremental run re-reads (late data protection) */
    reprocessDays: int("reprocess_days").notNull().default(7),
    /**
     * The last heartbeat specifically - what the agent said about itself and
     * its JHCIS link. Kept separate from lastSeenAt because those answers go
     * stale on their own schedule: an upload proves the agent is alive but
     * says nothing about whether JHCIS is still reachable.
     */
    lastHeartbeatAt: datetime("last_heartbeat_at"),
    /**
     * The last authenticated request of any kind from this agent.
     *
     * Presence is decided from this, not from the heartbeat alone. An agent
     * uploading a long backfill is demonstrably alive - every chunk is a
     * signed request the server accepted - and calling it OFFLINE because the
     * dedicated heartbeat is a minute behind tells the operator the opposite
     * of what is happening on their screen.
     */
    lastSeenAt: datetime("last_seen_at"),
    /**
     * What the agent reported about its own link to JHCIS on that heartbeat.
     *
     * Central cannot see a รพ.สต.'s LAN, so this is the only way the web can
     * tell "the agent is fine but JHCIS is down" from "the agent is gone" -
     * two situations needing two different people, which used to collapse into
     * a single OFFLINE.
     */
    jhcisConnected: boolean("jhcis_connected"),
    lastJhcisCheckAt: datetime("last_jhcis_check_at"),
    /** chunks the agent still has queued and undelivered */
    pendingBatches: int("pending_batches").notNull().default(0),
    lastSyncAt: datetime("last_sync_at"),
    lastSuccessfulSyncAt: datetime("last_successful_sync_at"),
    lastError: text("last_error"),
    lastErrorAt: datetime("last_error_at"),
    /** watermark: highest visit_date successfully ingested */
    lastSyncedVisitDate: date("last_synced_visit_date", { mode: "string" }),
    syncCount: int("sync_count").notNull().default(0),
    failedCount: int("failed_count").notNull().default(0),
    /** set by an operator pressing "Sync Now"; the agent picks it up on its next heartbeat */
    syncRequestedAt: datetime("sync_requested_at"),
    /**
     * Service dates the operator asked for. Empty means "carry on from the
     * watermark"; set means re-read exactly this window, which is how someone
     * recovers a period they know is wrong without waiting for the schedule.
     */
    syncRequestedFrom: date("sync_requested_from", { mode: "string" }),
    syncRequestedTo: date("sync_requested_to", { mode: "string" }),
    /** same, but asks the agent to reconcile every month against JHCIS */
    verifyRequestedAt: datetime("verify_requested_at"),
    enrolledAt: datetime("enrolled_at"),
    revokedAt: datetime("revoked_at"),
    createdAt,
    updatedAt,
  },
  (t) => ({
    facilityIdx: index("agents_facility_idx").on(t.facilityId, t.status),
    ownerIdx: index("agents_owner_idx").on(t.ownerUserId),
    heartbeatIdx: index("agents_heartbeat_idx").on(t.lastHeartbeatAt),
    seenIdx: index("agents_seen_idx").on(t.lastSeenAt),
  }),
);

/**
 * Per-agent credentials. The shared secret is stored encrypted with
 * AGENT_SIGNING_SECRET (AES-256-GCM), so a database dump alone cannot be used
 * to forge agent requests. The plaintext is shown exactly once at enrollment.
 */
export const agentCredentials = mysqlTable(
  "agent_credentials",
  {
    id: id("id").primaryKey(),
    agentId: id("agent_id").notNull(),
    /** public identifier sent in the X-Agent-Key header */
    keyId: varchar("key_id", { length: 40 }).notNull(),
    secretEnc: varchar("secret_enc", { length: 255 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastUsedAt: datetime("last_used_at"),
    revokedAt: datetime("revoked_at"),
    createdAt,
  },
  (t) => ({
    keyUq: uniqueIndex("agent_credentials_key_uq").on(t.keyId),
    agentIdx: index("agent_credentials_agent_idx").on(t.agentId, t.isActive),
  }),
);

/** single-use, expiring enrollment tokens (PROJECT_SPEC section 23) */
export const agentEnrollmentTokens = mysqlTable(
  "agent_enrollment_tokens",
  {
    id: id("id").primaryKey(),
    agentId: id("agent_id").notNull(),
    facilityId: id("facility_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: datetime("expires_at").notNull(),
    usedAt: datetime("used_at"),
    createdByUserId: id("created_by_user_id"),
    createdAt,
  },
  (t) => ({
    tokenUq: uniqueIndex("agent_enrollment_tokens_hash_uq").on(t.tokenHash),
    agentIdx: index("agent_enrollment_tokens_agent_idx").on(t.agentId),
  }),
);

/** replay protection: every signed request carries a nonce stored here */
export const agentRequestNonces = mysqlTable(
  "agent_request_nonces",
  {
    nonce: varchar("nonce", { length: 64 }).primaryKey(),
    agentId: id("agent_id").notNull(),
    seenAt: datetime("seen_at").notNull(),
  },
  (t) => ({
    seenIdx: index("agent_request_nonces_seen_idx").on(t.seenAt),
  }),
);

/* ------------------------------------------------------------ sync batches */

export const syncBatches = mysqlTable(
  "sync_batches",
  {
    id: id("id").primaryKey(),
    /** agent-generated reference, e.g. SYNC-20260904-000001 */
    batchRef: varchar("batch_ref", { length: 40 }).notNull(),
    agentId: id("agent_id").notNull(),
    facilityId: id("facility_id").notNull(),
    mode: mysqlEnum("mode", SYNC_MODES).notNull().default("INCREMENTAL"),
    status: mysqlEnum("status", BATCH_STATUSES).notNull().default("STARTED"),
    rangeFrom: date("range_from", { mode: "string" }),
    rangeTo: date("range_to", { mode: "string" }),
    startedAt: datetime("started_at").notNull(),
    completedAt: datetime("completed_at"),
    recordsRead: int("records_read").notNull().default(0),
    recordsSent: int("records_sent").notNull().default(0),
    recordsAccepted: int("records_accepted").notNull().default(0),
    recordsRejected: int("records_rejected").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt,
    updatedAt,
  },
  (t) => ({
    batchRefUq: uniqueIndex("sync_batches_ref_uq").on(t.agentId, t.batchRef),
    facilityIdx: index("sync_batches_facility_idx").on(t.facilityId, t.startedAt),
    statusIdx: index("sync_batches_status_idx").on(t.status, t.startedAt),
  }),
);

/** only rejected rows are persisted (accepted rows live in drug_usage) */
export const syncRejects = mysqlTable(
  "sync_rejects",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    batchId: id("batch_id").notNull(),
    facilityId: id("facility_id").notNull(),
    recordKey: char("record_key", { length: 64 }),
    reason: varchar("reason", { length: 255 }).notNull(),
    payload: json("payload"),
    createdAt,
  },
  (t) => ({
    batchIdx: index("sync_rejects_batch_idx").on(t.batchId),
  }),
);

/* ------------------------------------------------------------------ drugs */

/** canonical drug master, one row per (facility, drug_code) */
export const drugs = mysqlTable(
  "drugs",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    facilityId: id("facility_id").notNull(),
    drugCode: varchar("drug_code", { length: 24 }).notNull(),
    drugName: varchar("drug_name", { length: 255 }).notNull(),
    genericName: varchar("generic_name", { length: 220 }),
    drugType: varchar("drug_type", { length: 2 }),
    drugTypeSub: varchar("drug_type_sub", { length: 2 }),
    /** 1 = active, 2 = disabled in JHCIS (historical usage is still kept) */
    drugFlag: char("drug_flag", { length: 1 }),
    /** JHCIS unit codes plus the names resolved from cdrugunitsell */
    unitSell: varchar("unit_sell", { length: 15 }),
    unitSellName: varchar("unit_sell_name", { length: 64 }),
    unitUsage: varchar("unit_usage", { length: 15 }),
    unitUsageName: varchar("unit_usage_name", { length: 64 }),
    sourceVersion: varchar("source_version", { length: 40 }),
    syncedAt: datetime("synced_at"),
    createdAt,
    updatedAt,
  },
  (t) => ({
    facilityDrugUq: uniqueIndex("drugs_facility_code_uq").on(t.facilityId, t.drugCode),
    typeIdx: index("drugs_type_idx").on(t.facilityId, t.drugType),
  }),
);

/**
 * Drug dispensing facts.
 * record_key = sha256(facility_id|pcucode|visit_no|drug_code) makes re-uploads
 * idempotent (JHCIS_INTEGRATION section 13); drug_name_snapshot preserves the
 * historical drug name (section 16).
 */
export const drugUsage = mysqlTable(
  "drug_usage",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    recordKey: char("record_key", { length: 64 }).notNull(),
    facilityId: id("facility_id").notNull(),
    drugCode: varchar("drug_code", { length: 24 }).notNull(),
    drugNameSnapshot: varchar("drug_name_snapshot", { length: 255 }),
    drugType: varchar("drug_type", { length: 2 }),
    /** JHCIS visit reference only - never a patient identifier */
    visitNo: bigint("visit_no", { mode: "number" }).notNull(),
    usageDate: date("usage_date", { mode: "string" }).notNull(),
    quantity: decimal("quantity", { precision: 14, scale: 2 }).notNull(),
    /** human-readable unit (เม็ด, ขวด, ...) resolved from cdrugunitsell */
    unit: varchar("unit", { length: 64 }),
    /** the raw JHCIS unit code, kept so a wrong mapping stays traceable */
    unitCode: varchar("unit_code", { length: 15 }),
    clinic: varchar("clinic", { length: 5 }),
    /** JHCIS had no visit row for this dispensing: date fell back to dateupdate */
    visitMissing: boolean("visit_missing").notNull().default(false),
    sourcePcucode: char("source_pcucode", { length: 5 }).notNull(),
    sourceVersion: varchar("source_version", { length: 40 }),
    syncBatchId: id("sync_batch_id").notNull(),
    agentId: id("agent_id").notNull(),
    createdAt,
    updatedAt,
  },
  (t) => ({
    recordKeyUq: uniqueIndex("drug_usage_record_key_uq").on(t.recordKey),
    reportIdx: index("drug_usage_report_idx").on(t.facilityId, t.usageDate, t.drugCode),
    drugIdx: index("drug_usage_drug_idx").on(t.facilityId, t.drugCode, t.usageDate),
    typeIdx: index("drug_usage_type_idx").on(t.facilityId, t.drugType, t.usageDate),
    // Every index above leads with facility_id, which a SUPER_ADMIN report
    // never constrains - it reads all facilities - so TiDB fell back to an
    // index full scan of the whole table for each query on the page. This one
    // leads with the column those reports always do constrain, the date
    // window, and carries quantity so the summary aggregates without touching
    // the rows.
    windowIdx: index("drug_usage_window_idx").on(
      t.usageDate,
      t.drugType,
      t.drugCode,
      t.quantity,
    ),
    batchIdx: index("drug_usage_batch_idx").on(t.syncBatchId),
    agentIdx: index("drug_usage_agent_idx").on(t.agentId, t.usageDate),
  }),
);

/* ------------------------------------------------------- audit & settings */

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    actorType: mysqlEnum("actor_type", ["USER", "AGENT", "SYSTEM"]).notNull(),
    actorId: id("actor_id"),
    actorLabel: varchar("actor_label", { length: 160 }),
    action: varchar("action", { length: 80 }).notNull(),
    resource: varchar("resource", { length: 60 }).notNull(),
    resourceId: varchar("resource_id", { length: 64 }),
    facilityId: id("facility_id"),
    ip: varchar("ip", { length: 45 }),
    metadata: json("metadata"),
    createdAt,
  },
  (t) => ({
    facilityIdx: index("audit_logs_facility_idx").on(t.facilityId, t.createdAt),
    actorIdx: index("audit_logs_actor_idx").on(t.actorId, t.createdAt),
    actionIdx: index("audit_logs_action_idx").on(t.action, t.createdAt),
  }),
);

export const systemSettings = mysqlTable("system_settings", {
  settingKey: varchar("setting_key", { length: 80 }).primaryKey(),
  value: json("value").notNull(),
  description: varchar("description", { length: 255 }),
  updatedAt,
});

/* -------------------------------------------------------------- relations */

export const facilitiesRelations = relations(facilities, ({ many }) => ({
  users: many(users),
  agents: many(agents),
}));

export const usersRelations = relations(users, ({ one }) => ({
  facility: one(facilities, { fields: [users.facilityId], references: [facilities.id] }),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  facility: one(facilities, { fields: [agents.facilityId], references: [facilities.id] }),
  credentials: many(agentCredentials),
  batches: many(syncBatches),
}));

export const syncBatchesRelations = relations(syncBatches, ({ one }) => ({
  agent: one(agents, { fields: [syncBatches.agentId], references: [agents.id] }),
  facility: one(facilities, { fields: [syncBatches.facilityId], references: [facilities.id] }),
}));

export type UserRole = (typeof USER_ROLES)[number];
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type SyncMode = (typeof SYNC_MODES)[number];
export type BatchStatus = (typeof BATCH_STATUSES)[number];
