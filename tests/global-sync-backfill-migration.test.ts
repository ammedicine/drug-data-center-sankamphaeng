import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

describe("Phase E additive persistence", () => {
  it("defines the minimal historical request lifecycle table", () => {
    const table = (schema as Record<string, unknown>)
      .globalSyncBackfillRequests;
    expect(table).toBeDefined();

    const config = getTableConfig(
      table as Parameters<typeof getTableConfig>[0],
    );
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "agent_id",
      "facility_id",
      "policy_revision",
      "range_from",
      "range_to",
      "requested_by_user_id",
      "reason",
      "status",
      "linked_batch_id",
      "reconciliation_expected",
      "reconciliation_central",
      "reconciliation_gap",
      "quarantine_covered",
      "quarantine_unresolved",
      "result_message",
      "error_message",
      "requested_at",
      "started_at",
      "completed_at",
      "failed_at",
      "cancelled_at",
      "created_at",
      "updated_at",
    ]);
  });

  it("keeps Phase E Agent telemetry nullable without changing legacy counters", () => {
    const columns = new Map(
      getTableConfig(schema.agents).columns.map((column) => [
        column.name,
        column,
      ]),
    );

    for (const name of [
      "queue_pending_count",
      "queue_failed_count",
      "quarantine_total_count",
      "quarantine_covered_count",
      "quarantine_unresolved_count",
      "queue_telemetry_at",
    ]) {
      expect(columns.get(name), name).toMatchObject({ notNull: false });
    }
    expect(columns.get("pending_batches")).toMatchObject({
      notNull: true,
      default: 0,
    });
    expect(columns.get("failed_count")).toMatchObject({
      notNull: true,
      default: 0,
    });
    expect(columns.get("sync_requested_at")).toMatchObject({ notNull: false });
  });
});
