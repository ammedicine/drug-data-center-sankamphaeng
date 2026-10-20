import { z } from "zod";

import { globalSyncStartDateIsoDateSchema } from "@/lib/services/global-sync-policy";

export const heartbeatSchema = z.object({
  agentVersion: z.string().max(40),
  hostname: z.string().max(120),
  installationId: z.string().max(64),
  status: z.enum(["ONLINE", "SYNCING", "ERROR"]),
  jhcisConnected: z.boolean(),
  pcucode: z.string().max(5).nullable(),
  mysqlVersion: z.string().max(40).nullable().optional(),
  jhcisVersion: z.string().max(40).nullable().optional(),
  schemaReport: z.record(z.unknown()).nullable().optional(),
  lastError: z.string().max(2000).nullable().optional(),
  pendingBatches: z.number().int().min(0).optional(),
  syncRanAt: z.string().datetime().nullable().optional(),

  /* ------------------------------------------ what this build is and can do */
  buildId: z.string().max(40).nullable().optional(),
  capabilities: z.record(z.boolean()).nullable().optional(),
  syncStartDate: globalSyncStartDateIsoDateSchema.nullable().optional(),
  appliedGlobalSyncStartDateRevision: z.number().int().safe().min(1).nullable().optional(),

  /* ------------------------------------------- acknowledging control state */
  effectiveSyncState: z.enum(["RUNNING", "PAUSE_REQUESTED", "PAUSED"]).nullable().optional(),
  appliedControlRevision: z.number().int().min(0).nullable().optional(),

  network: z
    .object({
      macAddress: z.string().max(32).nullable(),
      ipAddress: z.string().max(45).nullable(),
      interfaceName: z.string().max(80).nullable(),
    })
    .nullable()
    .optional(),

  /* ------------------------------------------------- software update report */
  update: z
    .object({
      commandId: z.string().max(30).nullable().optional(),
      state: z.string().max(24).nullable().optional(),
      targetVersion: z.string().max(40).nullable().optional(),
      errorCode: z.string().max(40).nullable().optional(),
      errorMessage: z.string().max(400).nullable().optional(),
      errorAt: z.string().max(40).nullable().optional(),
      succeededAt: z.string().max(40).nullable().optional(),
      checkedAt: z.string().max(40).nullable().optional(),
      task: z.record(z.unknown()).nullable().optional(),
    })
    .nullable()
    .optional(),
});
