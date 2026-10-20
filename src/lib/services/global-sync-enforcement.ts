import { AgentAuthError } from "@/lib/agent-auth/verify";

import {
  globalSyncStartDateIsoDateSchema,
  globalSyncStartDatePolicyService,
  type GlobalSyncStartDatePolicy,
} from "./global-sync-policy";

export const GLOBAL_SYNC_START_DATE_ENFORCED_CODE = "GLOBAL_SYNC_START_DATE_ENFORCED";
export const GLOBAL_SYNC_START_DATE_ENFORCED_STATUS = 503;
export const GLOBAL_SYNC_START_DATE_RETRY_AFTER_SECONDS = 45;

export class GlobalSyncStartDateEnforcedError extends AgentAuthError {
  readonly retryAfterSeconds = GLOBAL_SYNC_START_DATE_RETRY_AFTER_SECONDS;

  constructor(readonly activeDate: string) {
    super(
      GLOBAL_SYNC_START_DATE_ENFORCED_STATUS,
      GLOBAL_SYNC_START_DATE_ENFORCED_CODE,
      `ข้อมูลมีวันที่ก่อน Global Sync Start Date ที่กำลังบังคับใช้ (${activeDate})`,
    );
    this.name = "GlobalSyncStartDateEnforcedError";
  }
}

function activeFloor(policy: GlobalSyncStartDatePolicy | null): string | null {
  return policy?.activeRevision && policy.activeDate ? policy.activeDate : null;
}

/** Pure range guard used before a batch can be opened or resumed. */
export function assertGlobalSyncStartDateRangeAllowed(
  policy: GlobalSyncStartDatePolicy | null,
  range: { rangeFrom: string | null; rangeTo: string | null },
): void {
  const floor = activeFloor(policy);
  if (!floor) return;
  if ((range.rangeFrom && range.rangeFrom < floor) || (range.rangeTo && range.rangeTo < floor)) {
    throw new GlobalSyncStartDateEnforcedError(floor);
  }
}

/** Pure whole-chunk guard: one below-floor row refuses the entire request. */
export function assertGlobalSyncStartDateRecordsAllowed(
  policy: GlobalSyncStartDatePolicy | null,
  records: Array<{ usageDate: string }>,
): void {
  const floor = activeFloor(policy);
  if (!floor) return;
  if (
    records.some(
      (record) =>
        globalSyncStartDateIsoDateSchema.safeParse(record.usageDate).success &&
        record.usageDate < floor,
    )
  ) {
    throw new GlobalSyncStartDateEnforcedError(floor);
  }
}

export async function assertCurrentGlobalSyncStartDateRangeAllowed(range: {
  rangeFrom: string | null;
  rangeTo: string | null;
}): Promise<void> {
  assertGlobalSyncStartDateRangeAllowed(await globalSyncStartDatePolicyService.get(), range);
}

export async function assertCurrentGlobalSyncStartDateRecordsAllowed(
  records: Array<{ usageDate: string }>,
): Promise<void> {
  assertGlobalSyncStartDateRecordsAllowed(await globalSyncStartDatePolicyService.get(), records);
}
