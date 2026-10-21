import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { agents, systemSettings } from "@/lib/db/schema";

export const GLOBAL_SYNC_START_DATE_POLICY_KEY = "global_sync_start_date_policy";

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const globalSyncStartDateIsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, "Date must be a real ISO calendar date");

export const globalSyncStartDateBackfillPlanSchema = z
  .object({
    policyRevision: z.number().int().safe().positive(),
    from: globalSyncStartDateIsoDateSchema,
    to: globalSyncStartDateIsoDateSchema,
    status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED", "SUPERSEDED"]),
    createdAt: z.string().datetime(),
    createdByUserId: z.string().min(1).max(30),
    resolvedAt: z.string().datetime().optional(),
    resolvedByUserId: z.string().min(1).max(30).optional(),
    resolutionReason: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from > value.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Backfill range is inverted" });
    }
    const resolutionFields = [value.resolvedAt, value.resolvedByUserId, value.resolutionReason];
    if (value.status === "ACTIVE" && resolutionFields.some(Boolean)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Active plan cannot be resolved" });
    }
    if (value.status !== "ACTIVE" && resolutionFields.some((field) => !field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Terminal plan requires resolution",
      });
    }
  });

export type GlobalSyncStartDateBackfillPlan = z.infer<
  typeof globalSyncStartDateBackfillPlanSchema
>;

export class BackfillPlanConflictError extends Error {
  constructor() {
    super("An unresolved backfill plan blocks this policy activation");
    this.name = "BackfillPlanConflictError";
  }
}

export function dayBeforeIsoDate(value: string): string {
  const date = new Date(`${globalSyncStartDateIsoDateSchema.parse(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function deriveBackfillPlanForActivation(input: {
  previousActiveDate: string | null;
  newActiveDate: string;
  policyRevision: number;
  actorUserId: string;
  now: Date;
  currentPlan: GlobalSyncStartDateBackfillPlan | null;
}): GlobalSyncStartDateBackfillPlan | null {
  const newActiveDate = globalSyncStartDateIsoDateSchema.parse(input.newActiveDate);
  if (input.currentPlan?.status === "ACTIVE") {
    if (input.previousActiveDate === newActiveDate) return input.currentPlan;
    throw new BackfillPlanConflictError();
  }
  if (!input.previousActiveDate || newActiveDate >= input.previousActiveDate) return null;
  return globalSyncStartDateBackfillPlanSchema.parse({
    policyRevision: input.policyRevision,
    from: newActiveDate,
    to: dayBeforeIsoDate(input.previousActiveDate),
    status: "ACTIVE",
    createdAt: input.now.toISOString(),
    createdByUserId: z.string().min(1).max(30).parse(input.actorUserId),
  });
}

const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    desiredDate: globalSyncStartDateIsoDateSchema,
    desiredRevision: z.number().int().safe().positive(),
    activeDate: globalSyncStartDateIsoDateSchema.nullable(),
    activeRevision: z.number().int().safe().min(0),
    updatedBy: z.string().min(1).max(30),
    updatedAt: z.string().datetime(),
    backfillPlan: globalSyncStartDateBackfillPlanSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.activeDate === null) !== (value.activeRevision === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "activeDate must be null exactly when activeRevision is zero",
        path: ["activeDate"],
      });
    }
    if (value.activeRevision > value.desiredRevision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "activeRevision cannot be newer than desiredRevision",
        path: ["activeRevision"],
      });
    }
  });

export type GlobalSyncStartDatePolicy = z.infer<typeof policySchema>;

export class GlobalSyncStartDatePolicyValidationError extends Error {
  constructor(readonly cause: z.ZodError) {
    super("Stored Global Sync Start Date policy is invalid");
    this.name = "GlobalSyncStartDatePolicyValidationError";
  }
}

export class GlobalSyncStartDatePolicyConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Global Sync Start Date policy changed concurrently (expected ${expectedRevision}, actual ${actualRevision})`,
    );
    this.name = "GlobalSyncStartDatePolicyConflictError";
  }
}

export function parseGlobalSyncStartDatePolicy(value: unknown): GlobalSyncStartDatePolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new GlobalSyncStartDatePolicyValidationError(parsed.error);
  return parsed.data;
}

export interface LockedGlobalSyncStartDatePolicy {
  value: unknown | null;
  save(value: GlobalSyncStartDatePolicy): Promise<void>;
}

export interface GlobalSyncStartDatePolicyStore {
  read(): Promise<unknown | null>;
  withLock<T>(work: (locked: LockedGlobalSyncStartDatePolicy) => Promise<T>): Promise<T>;
}

const drizzlePolicyStore: GlobalSyncStartDatePolicyStore = {
  async read() {
    const [row] = await db
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.settingKey, GLOBAL_SYNC_START_DATE_POLICY_KEY))
      .limit(1);
    return row?.value ?? null;
  },

  async withLock(work) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.settingKey, GLOBAL_SYNC_START_DATE_POLICY_KEY))
        .limit(1)
        .for("update");

      return work({
        value: row?.value ?? null,
        save: async (value) => {
          if (row) {
            await tx
              .update(systemSettings)
              .set({ value })
              .where(eq(systemSettings.settingKey, GLOBAL_SYNC_START_DATE_POLICY_KEY));
            return;
          }
          await tx.insert(systemSettings).values({
            settingKey: GLOBAL_SYNC_START_DATE_POLICY_KEY,
            value,
            description: "District-wide desired and active sync start date policy",
          });
        },
      });
    });
  },
};

export function createGlobalSyncStartDatePolicyService(
  store: GlobalSyncStartDatePolicyStore = drizzlePolicyStore,
) {
  return {
    async get(): Promise<GlobalSyncStartDatePolicy | null> {
      const value = await store.read();
      return value === null ? null : parseGlobalSyncStartDatePolicy(value);
    },

    async setDesiredDate(input: {
      desiredDate: string;
      expectedDesiredRevision: number;
      updatedBy: string;
      now?: Date;
    }): Promise<{ changed: boolean; policy: GlobalSyncStartDatePolicy }> {
      const desiredDate = globalSyncStartDateIsoDateSchema.parse(input.desiredDate);
      if (!Number.isSafeInteger(input.expectedDesiredRevision) || input.expectedDesiredRevision < 0) {
        throw new RangeError("expectedDesiredRevision must be a non-negative safe integer");
      }
      const updatedBy = z.string().min(1).max(30).parse(input.updatedBy);
      const updatedAt = (input.now ?? new Date()).toISOString();

      return store.withLock(async (locked) => {
        const current = locked.value === null ? null : parseGlobalSyncStartDatePolicy(locked.value);

        // A retried request for the already-desired date is idempotent even if
        // its expected revision is now stale.
        if (current?.desiredDate === desiredDate) {
          return { changed: false, policy: current };
        }

        const actualRevision = current?.desiredRevision ?? 0;
        if (input.expectedDesiredRevision !== actualRevision) {
          throw new GlobalSyncStartDatePolicyConflictError(
            input.expectedDesiredRevision,
            actualRevision,
          );
        }

        const policy = parseGlobalSyncStartDatePolicy({
          schemaVersion: 1,
          desiredDate,
          desiredRevision: actualRevision + 1,
          activeDate: current?.activeDate ?? null,
          activeRevision: current?.activeRevision ?? 0,
          updatedBy,
          updatedAt,
          ...(current?.backfillPlan ? { backfillPlan: current.backfillPlan } : {}),
        });
        await locked.save(policy);
        return { changed: true, policy };
      });
    },
  };
}

export const globalSyncStartDatePolicyService = createGlobalSyncStartDatePolicyService();

export function buildGlobalSyncStartDateHeartbeatConfig(
  policy: GlobalSyncStartDatePolicy | null,
):
  | Record<string, never>
  | {
      globalSyncStartDatePolicy: Pick<
        GlobalSyncStartDatePolicy,
        "schemaVersion" | "desiredDate" | "desiredRevision" | "activeDate" | "activeRevision"
      >;
    } {
  if (!policy) return {};
  return {
    globalSyncStartDatePolicy: {
      schemaVersion: policy.schemaVersion,
      desiredDate: policy.desiredDate,
      desiredRevision: policy.desiredRevision,
      activeDate: policy.activeDate,
      activeRevision: policy.activeRevision,
    },
  };
}

export interface LockedAgentGlobalSyncStartDateAcknowledgement {
  revision: number | null;
  save(revision: number, appliedAt: Date): Promise<void>;
}

export interface GlobalSyncStartDateAcknowledgementStore {
  withAgentLock<T>(
    agentId: string,
    work: (locked: LockedAgentGlobalSyncStartDateAcknowledgement) => Promise<T>,
  ): Promise<T>;
}

const drizzleAcknowledgementStore: GlobalSyncStartDateAcknowledgementStore = {
  async withAgentLock(agentId, work) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ revision: agents.globalSyncStartDateAppliedRevision })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
        .for("update");
      if (!row) throw new Error("Authenticated Agent no longer exists");

      return work({
        revision: row.revision,
        save: async (revision, appliedAt) => {
          await tx
            .update(agents)
            .set({
              globalSyncStartDateAppliedRevision: revision,
              globalSyncStartDateAppliedAt: appliedAt,
            })
            .where(eq(agents.id, agentId));
        },
      });
    });
  },
};

export function createGlobalSyncStartDateAcknowledgementService(
  store: GlobalSyncStartDateAcknowledgementStore = drizzleAcknowledgementStore,
) {
  return {
    async record(input: {
      authenticatedAgentId: string;
      reportedRevision: number;
      policy: GlobalSyncStartDatePolicy | null;
      appliedAt?: Date;
    }): Promise<boolean> {
      if (
        !input.policy ||
        !Number.isSafeInteger(input.reportedRevision) ||
        input.reportedRevision < 1 ||
        input.reportedRevision > input.policy.desiredRevision
      ) {
        return false;
      }

      return store.withAgentLock(input.authenticatedAgentId, async (locked) => {
        if (locked.revision !== null && locked.revision >= input.reportedRevision) return false;
        await locked.save(input.reportedRevision, input.appliedAt ?? new Date());
        return true;
      });
    },
  };
}

export const globalSyncStartDateAcknowledgementService =
  createGlobalSyncStartDateAcknowledgementService();
