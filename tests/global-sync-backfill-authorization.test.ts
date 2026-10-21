import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("historical paused authorization wiring", () => {
  it("uses an exact linked-batch guard before and inside receipt ingestion", () => {
    const route = readFileSync(
      "src/app/api/agent/sync/upload/route.ts",
      "utf8",
    );
    const service = readFileSync("src/lib/services/sync.ts", "utf8");
    expect(route).toContain(
      "await assertAgentSyncAllowedForBatch(agent.agentId, body.batchRef)",
    );
    expect(service).toContain(
      "await assertAgentSyncAllowedForBatch(input.agent.agentId, input.batchRef)",
    );
  });

  it("keeps legacy non-receipt uploads on the ordinary pause barrier", () => {
    const route = readFileSync(
      "src/app/api/agent/sync/upload/route.ts",
      "utf8",
    );
    expect(route).toContain("await assertAgentSyncAllowed(agent.agentId)");
  });

  it("requires active request, exact batch, Agent, plan and policy revision", () => {
    const guard = readFileSync("src/lib/agent-auth/sync-control.ts", "utf8");
    for (const evidence of [
      "eq(syncBatches.agentId, agentId)",
      "eq(syncBatches.batchRef, batchRef)",
      "eq(globalSyncBackfillRequests.agentId, agentId)",
      'eq(globalSyncBackfillRequests.status, "IN_PROGRESS")',
      'plan?.status === "ACTIVE"',
      "policy?.activeRevision === authorization.policyRevision",
    ])
      expect(guard).toContain(evidence);
  });

  it("suppresses both Agent and Central watermark changes for historical intent", () => {
    const agent = readFileSync("agent/src/sync.ts", "utf8");
    const central = readFileSync(
      "src/app/api/agent/sync/complete/route.ts",
      "utf8",
    );
    expect(agent).toContain(
      "lastVisitDate: complete && !options.historicalBackfill ? verifiedThrough : null",
    );
    expect(agent).toContain("if (complete && !options.historicalBackfill)");
    expect(central).toContain("globalSyncBackfillService.complete");
  });
});
