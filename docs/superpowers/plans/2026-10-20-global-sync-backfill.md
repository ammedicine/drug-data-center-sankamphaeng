# Controlled Historical Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement one-Agent-at-a-time Global Sync Start Date historical backfill through the existing `MANUAL_RANGE` flow, with durable lifecycle, exact paused authorization, watermark isolation, quarantine coverage, and current-request readiness.

**Architecture:** Add one lifecycle table and nullable Agent telemetry in migration 0014. Central delivers an optional request context over heartbeat and authorizes only its linked batch while paused; the Agent persists that context, reuses Phase D chunk receipts, and suppresses watermark progress only for this explicit intent. A separate pure readiness evaluator combines the active plan, current request, live batch, nullable telemetry, coverage, and errors for `/admin/fleet`.

**Tech Stack:** TypeScript, Next.js 15 server actions/route handlers, Drizzle ORM and additive MySQL/TiDB SQL, React 19, Vitest, Agent filesystem JSON queue.

**Spec:** `docs/GLOBAL_SYNC_BACKFILL.md`

## Global Constraints

- JHCIS is strictly read-only; add no JHCIS write or schema path.
- Preserve legacy `pendingBatches`, `failedCount`, `syncRequested*`, ordinary `MANUAL_RANGE`, purge, enrollment, credentials, facility isolation, and Phase D receipt semantics.
- One `REQUESTED` or `IN_PROGRESS` historical request may exist fleet-wide; every attempt gets a new immutable request ID.
- Missing Phase E telemetry is `UNKNOWN`, never zero.
- Only an active `SUPER_ADMIN` may request, cancel, complete/cancel/supersede a plan; `facilityId` is always derived server-side.
- Historical completion never updates local or Central `lastSyncedVisitDate`; normal modes retain current behavior.
- No auto backfill, fleet-wide backfill, auto resume, RU telemetry, purge redesign, quarantine deletion/rehydration, release/tag/publish, deployment, or unrelated refactor.
- Run focused tests only; do not run the full suite or live JHCIS tests. Maximum two implementation commits; do not push or deploy.

## Review Focus

- An older heartbeat omits every Phase E field: existing counters remain compatible, new telemetry stays `NULL`, and readiness is `UNKNOWN` (Task 2 heartbeat/readiness tests).
- A paused authorized batch coexists with an unrelated queued chunk: only the exact linked batch may upload (Task 1 Agent authorization test).
- The network fails after start but remains retryable: request and local context stay open and no failed completion is sent (Task 1 Agent retry test).
- Concurrent requests or repeated/late lifecycle messages race: one fleet request wins and terminal state cannot reopen (Task 1 lifecycle tests).
- A completed older request or partially overlapping quarantine file is presented as evidence: readiness rejects the old request and leaves partial coverage unresolved (Task 2 readiness/coverage tests).

---

### Task 1: Migration, Policy Gap, Lifecycle, Authorized Execution, and Watermark Isolation

**Files:**
- Create: `drizzle/0014_global_sync_backfill.sql`
- Create: `drizzle/meta/0014_snapshot.json`
- Create: `src/lib/services/global-sync-backfill.ts`
- Create: `agent/src/historical-backfill.ts`
- Create: `tests/global-sync-backfill-migration.test.ts`
- Create: `tests/global-sync-backfill-policy.test.ts`
- Create: `tests/global-sync-backfill-lifecycle.test.ts`
- Create: `tests/global-sync-backfill-authorization.test.ts`
- Create: `tests/global-sync-backfill-agent.test.ts`
- Modify: `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/services/global-sync-policy.ts`
- Modify: `src/lib/services/global-sync-policy-management.ts`
- Modify: `src/lib/agent-auth/sync-control.ts`
- Modify: `src/lib/services/sync.ts`
- Modify: `src/lib/services/audit.ts`
- Modify: `src/lib/shared/canonical.ts`
- Modify: `src/lib/agent-auth/heartbeat-schema.ts`
- Modify: `src/app/api/agent/heartbeat/route.ts`
- Modify: `src/app/api/agent/sync/start/route.ts`
- Modify: `src/app/api/agent/sync/upload/route.ts`
- Modify: `src/app/api/agent/sync/complete/route.ts`
- Modify: `src/app/(app)/admin/actions.ts`
- Modify: `agent/src/config.ts`
- Modify: `agent/src/central/client.ts`
- Modify: `agent/src/sync.ts`
- Modify: `agent/src/cli.ts`
- Modify: `tests/global-sync-management.test.ts`
- Modify: `tests/global-sync-heartbeat.test.ts`
- Modify: `tests/pause-authorization.test.ts`
- Modify: `tests/idempotent-upload-chunk-central.test.ts`

**Interfaces:**
- Produces `BACKFILL_REQUEST_STATUSES = ["REQUESTED", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED"]`, `globalSyncBackfillRequests`, and nullable Agent columns `queuePendingCount`, `queueFailedCount`, `quarantineTotalCount`, `quarantineCoveredCount`, `quarantineUnresolvedCount`, `queueTelemetryAt`.
- Produces typed `GlobalSyncStartDateBackfillPlan` with `policyRevision`, `from`, `to`, `status: "ACTIVE" | "COMPLETED" | "CANCELLED" | "SUPERSEDED"`, creation fields, and nullable resolution fields; policy schema version remains `1` and the property remains optional.
- Produces `createGlobalSyncBackfillService(store)` with `request`, `cancel`, `deliverForAgent`, `start`, `complete`, `reportTerminalFailure`, and `recordCoverage`; the default store owns transactions, locks, audit insertion, and atomic `syncRequested*` cleanup.
- Produces `assertAgentSyncAllowedForBatch(agentId: string, batchRef: string): Promise<void>`; it permits a paused write only for the exact active plan/request/linked batch and otherwise preserves `assertAgentSyncAllowed` behavior.
- Extends `SyncStartRequest` and `SyncCompleteRequest` with optional `historicalBackfill` context; legacy payloads remain valid. Upload continues to use `batchRef`, stable `chunkRef`, and payload SHA only.
- Produces Agent `HistoricalBackfillContext { requestId, policyRevision, from, to, batchRef }` persistence helpers and extends `SyncOptions` with optional `historicalBackfill`.

- [ ] **Step 1: Write failing migration/schema tests**

Add assertions that the table contains only the approved identity, Agent/facility, revision/range, actor/reason, status, linked batch, reconciliation, coverage, result/error, and lifecycle timestamp fields; assert all six new Agent telemetry fields are nullable and existing fields retain their existing nullability/defaults.

- [ ] **Step 2: Run the migration test and confirm red**

Run: `npx vitest run tests/global-sync-backfill-migration.test.ts`

Expected: FAIL because migration 0014 and the schema exports do not exist.

- [ ] **Step 3: Add the Drizzle schema and generate migration 0014**

Define the enums/table/columns/indexes in `src/lib/db/schema.ts`, then run `npx drizzle-kit generate --name global_sync_backfill`. Inspect the SQL and metadata: only `global_sync_backfill_requests` creation and nullable Agent telemetry `ALTER TABLE ... ADD` statements are allowed; no drop/rename/data rewrite/foreign key.

- [ ] **Step 4: Run the migration test and confirm green**

Run: `npx vitest run tests/global-sync-backfill-migration.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing policy-gap and plan-resolution tests**

In `tests/global-sync-backfill-policy.test.ts` and `tests/global-sync-management.test.ts`, pin these cases: desired-only change preserves the plan; first/forward/equal activation creates no plan; `2025-01-01 -> 2024-10-01` creates active `2024-10-01..2024-12-31`; an active incompatible plan blocks activation; audited `COMPLETED`, `CANCELLED`, or `SUPERSEDED` resolution permits a later activation; non-`SUPER_ADMIN` resolution is refused.

- [ ] **Step 6: Implement typed gap creation and audited plan resolution**

Add `dayBeforeIsoDate(date: string): string`, typed parsing, the backward-transition rule, `BACKFILL_PLAN_UNRESOLVED`, and `resolveBackfillPlan(input: { actorUserId; expectedPolicyRevision; resolution; reason; now?; ip? })` to the existing policy management service. Keep desired-date saves plan-neutral and activation atomic under the existing policy lock.

- [ ] **Step 7: Run focused policy tests**

Run: `npx vitest run tests/global-sync-policy.test.ts tests/global-sync-management.test.ts tests/global-sync-backfill-policy.test.ts`

Expected: PASS.

- [ ] **Step 8: Write failing lifecycle and authorization tests**

Use an injectable in-memory store to assert: server-derived facility; `SUPER_ADMIN` enforcement; exact active plan/range/revision; both capabilities; desired pause; effective pause before online execution; fresh known zero pending/failed telemetry; no active batch/manual request; serialized concurrent request creation; atomic request plus `syncRequested*`; immutable terminal states; unique new request ID after terminal retry; atomic terminal cleanup and audit; cancellation preserves data references. Test start idempotency, different-batch conflict, exact linked-batch pause access, ordinary paused denial, plan invalidation denial, reconciliation-gap completion denial, retryable failures staying open, and terminal failures closing authorization.

- [ ] **Step 9: Implement the lifecycle service and narrow Central authorization**

Implement the service/store boundary in `src/lib/services/global-sync-backfill.ts`. Refactor only the shared batch-persistence primitive needed so the service can atomically link `IN_PROGRESS` to the created/resumed batch. Route ordinary start through the unchanged legacy guard; route historical start/complete through the coordinator. For idempotent upload, call `assertAgentSyncAllowedForBatch` before the receipt transaction and again before writes. Never allow a request ID, Agent, revision, range, or batch mismatch.

- [ ] **Step 10: Add the additive heartbeat and API contracts**

Add optional `historicalBackfill` delivery and optional failure report fields to `HeartbeatRequest`/`AgentConfigResponse` and Zod schemas. Deliver only the authenticated Agent's `REQUESTED`/`IN_PROGRESS` request. Extend start and complete bodies with the exact context and reconciliation counts; legacy bodies remain accepted. Add audited `requestHistoricalBackfillAction`, `cancelHistoricalBackfillAction`, and plan-resolution action; each revalidates `/admin/fleet`.

- [ ] **Step 11: Run focused Central lifecycle/authorization tests**

Run: `npx vitest run tests/global-sync-backfill-lifecycle.test.ts tests/global-sync-backfill-authorization.test.ts tests/global-sync-heartbeat.test.ts tests/pause-authorization.test.ts tests/idempotent-upload-chunk-central.test.ts`

Expected: PASS, including legacy heartbeat/upload cases.

- [ ] **Step 12: Write failing Agent intent, restart, pause, retry, and watermark tests**

Assert the heartbeat context is persisted before start; the batch reference is stable after reload; a repeated instruction does not create another attempt; historical runs alone may cross local pause boundaries; unrelated queued batches are not uploaded; retryable network failure sends no terminal completion and retains context; successful historical completion sends `lastVisitDate: null` and leaves state watermark unchanged; ordinary `MANUAL_RANGE` still sends/saves its verified date.

- [ ] **Step 13: Implement explicit historical intent in the Agent**

Add atomic context helpers in `agent/src/historical-backfill.ts`. Extend the worker to dispatch a historical heartbeat request into `SyncRunner.run({ mode: "MANUAL_RANGE", from, to, historicalBackfill })`. Reuse the persisted batch reference, pass context to start/complete, scope local pause bypass and `flushQueue` to that batch only, omit failed completion for retryable pending work, include reconciliation proof, suppress `lastVisitDate` and local watermark save only for historical intent, and retain ordinary paths byte-for-byte where practical.

- [ ] **Step 14: Run focused Agent and regression tests**

Run: `npx vitest run tests/global-sync-backfill-agent.test.ts tests/pause-boundary.test.ts tests/pause-old-client.test.ts tests/idempotent-upload-chunk-agent.test.ts tests/remote-sync-start-date.test.ts`

Expected: PASS without live JHCIS.

- [ ] **Step 15: Verify Task 1 surfaces and commit**

Run: `npm run typecheck`

Run: `npm --prefix agent run typecheck`

Run: `npx eslint src/lib/services/global-sync-backfill.ts src/lib/services/global-sync-policy.ts src/lib/services/global-sync-policy-management.ts src/lib/agent-auth/sync-control.ts src/lib/services/sync.ts src/lib/shared/canonical.ts src/lib/agent-auth/heartbeat-schema.ts src/app/api/agent/heartbeat/route.ts src/app/api/agent/sync/start/route.ts src/app/api/agent/sync/upload/route.ts src/app/api/agent/sync/complete/route.ts 'src/app/(app)/admin/actions.ts' agent/src/historical-backfill.ts agent/src/config.ts agent/src/central/client.ts agent/src/sync.ts agent/src/cli.ts`

Review `git diff --check`, migration SQL, schema diff, and focused test output, then commit:

```bash
git add -- drizzle/0014_global_sync_backfill.sql drizzle/meta/0014_snapshot.json drizzle/meta/_journal.json src/lib/db/schema.ts src/lib/services/global-sync-backfill.ts src/lib/services/global-sync-policy.ts src/lib/services/global-sync-policy-management.ts src/lib/agent-auth/sync-control.ts src/lib/services/sync.ts src/lib/services/audit.ts src/lib/shared/canonical.ts src/lib/agent-auth/heartbeat-schema.ts src/app/api/agent/heartbeat/route.ts src/app/api/agent/sync/start/route.ts src/app/api/agent/sync/upload/route.ts src/app/api/agent/sync/complete/route.ts 'src/app/(app)/admin/actions.ts' agent/src/historical-backfill.ts agent/src/config.ts agent/src/central/client.ts agent/src/sync.ts agent/src/cli.ts tests/global-sync-backfill-migration.test.ts tests/global-sync-backfill-policy.test.ts tests/global-sync-backfill-lifecycle.test.ts tests/global-sync-backfill-authorization.test.ts tests/global-sync-backfill-agent.test.ts tests/global-sync-management.test.ts tests/global-sync-heartbeat.test.ts tests/pause-authorization.test.ts tests/idempotent-upload-chunk-central.test.ts
git commit -m "feat(sync): add controlled historical backfill"
```

### Task 2: Quarantine Coverage, Current-Request Readiness, Fleet UI, and Shared Docs

**Files:**
- Create: `src/lib/services/global-sync-backfill-readiness.ts`
- Create: `tests/global-sync-backfill-readiness.test.ts`
- Create: `tests/quarantine-coverage.test.ts`
- Modify: `agent/src/queue/queue.ts`
- Modify: `agent/src/historical-backfill.ts`
- Modify: `agent/src/sync.ts`
- Modify: `src/lib/shared/canonical.ts`
- Modify: `src/lib/agent-auth/heartbeat-schema.ts`
- Modify: `src/app/api/agent/heartbeat/route.ts`
- Modify: `src/lib/services/global-sync-backfill.ts`
- Modify: `src/lib/services/fleet.ts`
- Modify: `src/app/(app)/admin/fleet/page.tsx`
- Modify: `src/app/(app)/admin/fleet/fleet-controls.tsx`
- Modify: `src/app/(app)/admin/fleet/global-sync-start-date-panel.tsx`
- Modify: `tests/global-sync-heartbeat.test.ts`
- Modify: `tests/fleet-dashboard.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/API.md`
- Modify: `docs/DATABASE.md`
- Modify: `docs/SYNC.md`
- Modify: `docs/AGENT.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Produces `QuarantineSummary { total, covered, unresolved }` and `markQuarantineCovered(input: { requestId, batchRef, pcucode, from, to, coveredAt }): { covered, unresolvedRelevant }` on `OfflineQueue`.
- Adds optional heartbeat `queueTelemetry` and request-bound `historicalBackfillReport`; Central writes nullable telemetry only when the object is present and records coverage only when request/batch/revision/range match.
- Produces `BackfillReadinessState = "READY" | "NOT_READY" | "UNKNOWN"`, `BackfillReadinessReason`, and pure `evaluateGlobalSyncBackfillReadiness(input): { state, reasons }`.
- Extends `FleetAgentRow`/`FleetRowView` with capability, policy, request, eligibility, readiness, and quarantine fields used only on `/admin/fleet`.

- [ ] **Step 1: Write failing quarantine coverage tests**

Cover full-range marking, preserved payload/file, exact metadata, repeat idempotency with byte-identical second application, conflicting coverage refusal, partial overlap unresolved, unrelated file visible but not request-blocking, invalid/unreadable quarantine file counted unresolved, and no pending rehydration/deletion.

- [ ] **Step 2: Implement additive quarantine inspection and marking**

Add typed quarantine reads without changing pending/failed queue behavior. Mark only same-pcucode files whose every record is within range, via temp+rename; retain partial/unrelated/invalid files. Identical metadata is a no-op; conflicting metadata fails safely.

- [ ] **Step 3: Run quarantine tests**

Run: `npx vitest run tests/queue-floor.test.ts tests/quarantine-coverage.test.ts`

Expected: PASS.

- [ ] **Step 4: Write failing heartbeat telemetry and coverage-report tests**

Assert older payload omission leaves Phase E columns null; explicit zeros persist as zero; counts and timestamps come only from authenticated heartbeat; coverage evidence updates only the matching completed request; older request/revision/range/batch evidence is rejected; completion before coverage remains non-ready.

- [ ] **Step 5: Implement telemetry/reporting and crash-safe post-completion coverage**

Report current pending, failed, and quarantine summary on new Agent heartbeats. After a completed historical response, run idempotent coverage marking, persist the report in local context, and keep reporting until Central acknowledges it; then clear local historical context. Central stores telemetry with `queueTelemetryAt` and request-specific coverage in bounded fields without changing legacy `pendingBatches` handling.

- [ ] **Step 6: Run heartbeat and Agent coverage tests**

Run: `npx vitest run tests/global-sync-heartbeat.test.ts tests/global-sync-backfill-agent.test.ts tests/quarantine-coverage.test.ts`

Expected: PASS.

- [ ] **Step 7: Write failing readiness tests**

Pin `UNKNOWN` for absent/null/stale telemetry and evidence not matching current plan/request/revision/range. Pin `NOT_READY` for missing capabilities, revision/pause mismatch, active batch, unresolved manual/open request, pending/failed queue, incomplete/failed request, reconciliation gap, relevant partial coverage, or current relevant error. Pin `READY` only for a fresh completed current request with gap zero, relevant coverage resolved, zero queues, no live batch/request/error; unrelated quarantine remains visible and non-blocking.

- [ ] **Step 8: Implement the pure readiness evaluator and fleet query mapping**

Keep decision logic in `global-sync-backfill-readiness.ts` with an injected `now` and explicit freshness window shared with fleet presence rules. Fetch the active policy, current/open/latest matching requests, and fleet rows in bounded queries; never substitute legacy counters for nullable Phase E telemetry.

- [ ] **Step 9: Run readiness and fleet service tests**

Run: `npx vitest run tests/global-sync-backfill-readiness.test.ts tests/fleet-dashboard.test.ts`

Expected: PASS.

- [ ] **Step 10: Extend `/admin/fleet` only**

Add per-Agent capability/policy gate, active request status, `READY`/`NOT_READY`/`UNKNOWN` reasons, quarantine summary, exact range/reason request form, and cancel control. Disable request submission unless the server-derived eligibility is clean; keep server validation authoritative. Add active-plan status plus explicit complete/cancel/supersede controls to the existing Global Sync Start Date panel. Add no bulk backfill, automatic resume, or new page.

- [ ] **Step 11: Update only affected shared documentation**

Link the implemented lifecycle/protocol/table/telemetry/operations from `ARCHITECTURE.md`, `API.md`, `DATABASE.md`, `SYNC.md`, `AGENT.md`, `SECURITY.md`, and `DEPLOYMENT.md`. Reference `GLOBAL_SYNC_BACKFILL.md` rather than duplicating it; remove only statements made stale by the implementation.

- [ ] **Step 12: Run all Phase E focused tests together**

Run: `npx vitest run tests/global-sync-backfill-migration.test.ts tests/global-sync-backfill-policy.test.ts tests/global-sync-backfill-lifecycle.test.ts tests/global-sync-backfill-authorization.test.ts tests/global-sync-backfill-agent.test.ts tests/global-sync-backfill-readiness.test.ts tests/quarantine-coverage.test.ts tests/global-sync-management.test.ts tests/global-sync-heartbeat.test.ts tests/pause-authorization.test.ts tests/pause-boundary.test.ts tests/pause-old-client.test.ts tests/idempotent-upload-chunk-agent.test.ts tests/idempotent-upload-chunk-central.test.ts tests/remote-sync-start-date.test.ts tests/queue-floor.test.ts tests/fleet-dashboard.test.ts`

Expected: PASS. Do not run `npm test` or any live-JHCIS test.

- [ ] **Step 13: Run final static/build verification**

Run: `npm run typecheck`

Run: `npm --prefix agent run typecheck`

Run: `npm run lint`

Run: `npm run build`

Run: `npm --prefix agent run build`

Expected: every command exits `0`.

- [ ] **Step 14: Perform final diff controls and commit**

Verify `git diff --check`, `git status --short`, `git diff --stat HEAD~1`, and the full diff. Confirm migration 0014 is additive/minimal; no non-historical watermark change; no purge/RU/auto-resume/fleet-wide backfill/JHCIS write/release work; no secret; only approved docs changed.

```bash
git add -- src/lib/services/global-sync-backfill-readiness.ts src/lib/services/global-sync-backfill.ts src/lib/shared/canonical.ts src/lib/agent-auth/heartbeat-schema.ts src/app/api/agent/heartbeat/route.ts src/lib/services/fleet.ts 'src/app/(app)/admin/fleet/page.tsx' 'src/app/(app)/admin/fleet/fleet-controls.tsx' 'src/app/(app)/admin/fleet/global-sync-start-date-panel.tsx' agent/src/queue/queue.ts agent/src/historical-backfill.ts agent/src/sync.ts tests/global-sync-backfill-readiness.test.ts tests/quarantine-coverage.test.ts tests/global-sync-heartbeat.test.ts tests/fleet-dashboard.test.ts docs/ARCHITECTURE.md docs/API.md docs/DATABASE.md docs/SYNC.md docs/AGENT.md docs/SECURITY.md docs/DEPLOYMENT.md docs/superpowers/plans/2026-10-20-global-sync-backfill.md
git commit -m "feat(fleet): add backfill readiness visibility"
```

- [ ] **Step 15: Post-commit verification**

Verify the worktree is clean, `HEAD` is exactly two commits ahead of `7384a3e5fb7fb12f06a473ea1ea087a43cc9360d`, `origin/main` remains unchanged, and neither commit was pushed, deployed, tagged, or published. Report Phase E using the owner's short template and stop before Phase F.
