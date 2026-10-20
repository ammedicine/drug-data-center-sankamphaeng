import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";

import { agents } from "@/lib/db/schema";

describe("global sync start date acknowledgement schema", () => {
  it("keeps both new acknowledgement columns nullable for existing Agent rows", () => {
    const columns = new Map(
      getTableConfig(agents).columns.map((column) => [column.name, column]),
    );

    expect(columns.get("global_sync_start_date_applied_revision")).toMatchObject({
      notNull: false,
    });
    expect(columns.get("global_sync_start_date_applied_at")).toMatchObject({
      notNull: false,
    });
  });
});
