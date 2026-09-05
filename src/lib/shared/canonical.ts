/**
 * Canonical contract shared by the Central API and the Local Agent.
 *
 * This file is the single source of truth for:
 *  - the wire format of drug-usage records
 *  - the deterministic record key that makes uploads idempotent
 *  - the string that both sides sign with HMAC
 *
 * It is imported by the agent through the "@shared/*" path alias, so it must
 * stay free of Next.js / browser / agent-only dependencies.
 */
import { createHash, createHmac } from "node:crypto";

export const API_VERSION = "1";

/** Header names used by the agent protocol. */
export const AGENT_HEADERS = {
  key: "x-agent-key",
  timestamp: "x-agent-timestamp",
  nonce: "x-agent-nonce",
  signature: "x-agent-signature",
  version: "x-agent-version",
} as const;

// Drug category vocabulary lives in drug-types.ts so client components can
// import it without pulling node:crypto into the browser bundle.
export {
  DRUG_TYPE_LABELS,
  PRIMARY_DRUG_TYPES,
  drugStatus,
  drugTypeLabel,
  isPrimaryDrugType,
} from "./drug-types";

/** One dispensing row as extracted from JHCIS visitdrug + visit + cdrug. */
export interface DrugUsageRecord {
  visitNo: number;
  /** true when the visit row is gone from JHCIS and the date came from dateupdate */
  visitMissing?: boolean;
  drugCode: string;
  /** name at extraction time, kept as a historical snapshot */
  drugName: string | null;
  drugType: string | null;
  /** JHCIS visitdrug.unit - the dispensed amount (NOT a unit of measure) */
  quantity: number;
  /** unit of measure, already resolved to a name via cdrugunitsell */
  unit: string | null;
  /** the raw JHCIS unit code behind `unit` */
  unitCode: string | null;
  clinic: string | null;
  /** visit.visitdate, ISO yyyy-mm-dd */
  usageDate: string;
}

/** One drug-master row. */
export interface DrugMasterRecord {
  drugCode: string;
  drugName: string;
  genericName: string | null;
  drugType: string | null;
  drugTypeSub: string | null;
  drugFlag: string | null;
  unitSell: string | null;
  unitSellName: string | null;
  unitUsage: string | null;
  unitUsageName: string | null;
}

/**
 * Deterministic identity of a dispensing row.
 * JHCIS visitdrug PK is (pcucode, visitno, drugcode) - so that tuple plus the
 * central facility id uniquely identifies the fact, and re-sending it is safe.
 */
export function drugUsageRecordKey(input: {
  facilityId: string;
  pcucode: string;
  visitNo: number | string;
  drugCode: string;
}): string {
  const raw = [
    input.facilityId,
    input.pcucode,
    String(input.visitNo),
    input.drugCode.trim(),
  ].join("|");
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Canonical string signed by the agent:
 *   METHOD \n path \n timestamp \n nonce \n sha256(body)
 * Signing the body hash (not the body) keeps the signature stable regardless of
 * transfer encoding, and binds the request to its exact payload.
 */
export function buildSigningString(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    sha256Hex(input.body ?? ""),
  ].join("\n");
}

export function signRequest(secret: string, signingString: string): string {
  return createHmac("sha256", secret).update(signingString, "utf8").digest("hex");
}

/* --------------------------------------------------------- API payloads */

export interface SchemaReport {
  database: string;
  mysqlVersion: string;
  jhcisVersion: string | null;
  pcucode: string | null;
  facilityName: string | null;
  tables: Record<string, boolean>;
  columns: Record<string, Record<string, boolean>>;
  capabilities: {
    supportsDrugUsage: boolean;
    supportsQuantity: boolean;
    supportsDispensedDate: boolean;
    supportsDrugType: boolean;
    /** cdrugunitsell is present, so unit codes can be shown as names */
    supportsUnitName: boolean;
  };
  /** rows that cannot be tied back to a visit record (still extracted) */
  dataQuality?: {
    visitDrugRows: number;
    orphanVisitDrugRows: number;
  };
  /** resolved column mapping actually used by the extractor */
  mapping: {
    quantityColumn: string | null;
    unitColumn: string | null;
    dateColumn: string | null;
  };
  warnings: string[];
}

export interface HeartbeatRequest {
  agentVersion: string;
  hostname: string;
  installationId: string;
  status: "ONLINE" | "SYNCING" | "ERROR";
  jhcisConnected: boolean;
  pcucode: string | null;
  mysqlVersion?: string | null;
  jhcisVersion?: string | null;
  schemaReport?: SchemaReport | null;
  lastError?: string | null;
  pendingBatches?: number;
  /**
   * The network card this agent actually reaches Central through. Reported so
   * an operator can tell which physical machine a สถานบริการ is syncing from -
   * useful when a clinic has several PCs and one of them is stale.
   */
  network?: {
    macAddress: string | null;
    ipAddress: string | null;
    interfaceName: string | null;
  } | null;
}

export interface AgentConfigResponse {
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  expectedPcucode: string;
  syncIntervalMinutes: number;
  reprocessDays: number;
  /** watermark the central server has, used to resume incremental sync */
  lastSyncedVisitDate: string | null;
  uploadChunkSize: number;
  disabled: boolean;
  /** an operator asked for an immediate sync (PROJECT_SPEC section 13) */
  syncRequested: boolean;
  /**
   * Service dates the operator asked to re-read. Null means resume from the
   * watermark; a range means read exactly that window, whether or not the
   * agent believes it already delivered it.
   */
  syncRequestedFrom?: string | null;
  syncRequestedTo?: string | null;
  /** an operator asked for a full month-by-month reconciliation */
  verifyRequested: boolean;
}

export interface SyncStartRequest {
  batchRef: string;
  mode: "INITIAL" | "INCREMENTAL" | "MANUAL_RANGE" | "RETRY";
  rangeFrom: string | null;
  rangeTo: string | null;
  pcucode: string;
  recordsRead: number;
}

export interface SyncUploadRequest {
  batchRef: string;
  pcucode: string;
  sourceVersion: string | null;
  drugs?: DrugMasterRecord[];
  records: DrugUsageRecord[];
}

export interface SyncUploadResponse {
  accepted: number;
  rejected: number;
  rejects: Array<{ recordKey: string | null; reason: string }>;
}

export interface SyncCompleteRequest {
  batchRef: string;
  status: "COMPLETED" | "FAILED" | "ABORTED";
  recordsRead: number;
  recordsSent: number;
  lastVisitDate: string | null;
  errorMessage?: string | null;
}
