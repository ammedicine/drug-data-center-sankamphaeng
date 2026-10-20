# Controlled Historical Backfill

This document defines the Phase E contract for controlled historical recovery after a Global Sync Start Date floor moves backward. It extends, but does not replace, the shared architecture in [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md), [DATABASE.md](DATABASE.md), [SYNC.md](SYNC.md), [AGENT.md](AGENT.md), [SECURITY.md](SECURITY.md), and [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Purpose and scope

Phase E permits a `SUPER_ADMIN` to recover one Agent at a time through the existing `MANUAL_RANGE` extraction, upload, and reconciliation flow. It adds only the durable request lifecycle, narrowly scoped paused-operation authorization, queue/quarantine telemetry, quarantine coverage evidence, and readiness decision required to operate that flow safely.

Changing or activating a policy never starts backfill. JHCIS remains strictly read-only, normal sync remains paused, and existing manual-range, watermark, purge, receipt, facility-isolation, and enrollment behavior is preserved unless this contract explicitly distinguishes historical intent.

## 2. Persistence model

Migration `0014_global_sync_backfill` is additive and minimal. It adds a durable historical-backfill request record containing:

- an immutable request ID;
- authoritative `agent_id` and a server-derived `facility_id` for audit/query convenience;
- active policy revision and exact authorized date range;
- requesting user, reason, and lifecycle status;
- linked Central batch reference when execution starts;
- reconciliation result, relevant quarantine coverage result, bounded error/result text, and lifecycle timestamps.

Each attempt receives a new request ID. Only one request in `REQUESTED` or `IN_PROGRESS` may exist fleet-wide. Creation is serialized under a database lock; application-level integrity is used in accordance with the TiDB conventions in `DATABASE.md`.

Agent readiness telemetry is stored separately as nullable current pending, failed, quarantine-total, quarantine-covered, and quarantine-unresolved counts plus its report time. `NULL` means `UNKNOWN`, never zero. The meanings of existing `pendingBatches`, `failedCount`, and `syncRequested*` fields do not change.

## 3. Backfill-gap authority

A backfill plan is created only by a successful active-to-active backward policy activation. Given the previously enforced `previousActiveDate` and newly activated `newActiveDate`, when `newActiveDate < previousActiveDate` the plan authorizes:

```text
from = newActiveDate
to   = dayBefore(previousActiveDate)
```

First activation from legacy state, a forward or equal active-floor transition, and a desired-date change create no gap. A plan authorizes ranges only and never schedules work.

An unresolved plan must be explicitly completed, cancelled, or superseded by a `SUPER_ADMIN` action with reason and audit record before an incompatible policy activation. A request range must be contained by the current plan, must not precede the active floor, and must bind to that plan's active revision.

## 4. Request lifecycle

Allowed transitions are:

```text
REQUESTED -> IN_PROGRESS -> COMPLETED
    |              |-----> FAILED
    |--------------+-----> CANCELLED
    +--------------------> FAILED
```

`IN_PROGRESS` begins only when Central accepts the exact Agent/request/revision/range start. `COMPLETED` requires successful upload completion and reconciliation gap zero. An authenticated Agent may report a non-retryable pre-start or in-progress failure. A `SUPER_ADMIN` may cancel an open request. Terminal states never reopen; retry after a terminal state creates a new request.

Cancellation closes authorization immediately but does not delete queue files, quarantine files, upload receipts, or already-ingested Central data. Clearing the matching legacy `syncRequested*` fields occurs in the same transaction as completion, failure, or cancellation so no ghost manual request remains.

## 5. Delivery protocol and paused authorization

The `/admin/fleet` action accepts `agentId`, exact range, and reason. Central derives facility identity and validates role, current plan, capabilities, applied policy revision, desired pause, effective pause when online, fresh queue telemetry, absence of an active batch, and absence of conflicting manual/backfill work. Pending and failed queue counts must be known and zero; preserved quarantine may be nonzero.

A valid request sets the existing `syncRequestedAt/from/to` fields and is delivered through the existing heartbeat response with optional historical context: request ID, active policy revision, and exact range. No parallel transport is introduced.

The Agent persists that context and its batch reference before execution. It supplies the request ID to the existing sync-start flow. Central links the accepted batch to the request and permits start, upload, and completion while paused only when the authenticated Agent, request, revision, range, and linked batch all match. Upload and completion resolve authorization through the authenticated Agent and linked batch, not through frontend identity or an unverified batch reference.

The local Agent bypasses pause checks only inside this authorized execution, including chunk-boundary checks. Scheduled, incremental, initial, ordinary manual-range, retry, and unrelated batch operations remain blocked. Authorization ends immediately when the request becomes terminal.

## 6. Historical intent and watermark isolation

Authorized Global Sync Start Date backfill carries an explicit historical intent. Ordinary `MANUAL_RANGE` carries no such intent and retains its existing behavior.

Historical execution uses existing JHCIS extraction and reconciliation and existing Phase D stable `chunkRef` and payload identity. On successful historical completion the Agent sends no `lastVisitDate`, does not change its local `lastSyncedVisitDate`, and causes no Central watermark update. Restart reuses the persisted request and batch context rather than creating a new attempt identity. Purge remains the only existing deliberate rewind path.

## 7. Retry and failure semantics

Repeated heartbeat delivery and repeated start with the same request and batch reference are idempotent. A different batch reference for an already-started request is a conflict. Ambiguous upload responses retry the same Phase D receipt identity; the same `chunkRef` with a different payload fails closed.

Transient or retryable network failures do not move a request to `FAILED` while safe retry remains possible. A silent or stalled request remains open and blocks readiness until it continues or an operator cancels it. Non-retryable protocol/data-integrity failure, explicit failed completion, or reconciliation mismatch may produce `FAILED`. Failure never marks quarantine coverage and never changes the watermark.

Pending or failed queue items after terminal failure remain preserved and visible. They are not automatically deleted, rehomed, rehydrated, resumed, or converted into a new request.

## 8. Quarantine coverage

Only after Central acknowledges successful completion with reconciliation gap zero may the Agent mark quarantine evidence. A quarantine file is covered only when its `pcucode` matches the enrolled Agent and every record lies within the exact authorized range.

Coverage adds `coveredByBatchRef`, `coveredAt`, and `coveredRange` by atomic temp-file rename. It never alters record payloads or deletes/moves the file. Applying the same completed request/batch again is idempotent and does not duplicate or replace identical coverage metadata. Conflicting existing coverage fails safely.

Partially overlapping files and files outside the range remain unchanged and unresolved. The Agent then reports current quarantine counts and request-specific coverage evidence. A crash between Central completion and local coverage reporting resumes this idempotent coverage step from persisted historical context.

## 9. Readiness semantics

The fleet service returns `READY`, `NOT_READY`, or `UNKNOWN` with reasons for the current Agent. Evidence is valid only when it matches the current backfill plan, request ID, policy revision, and exact range. Evidence from an older attempt is never reused.

`UNKNOWN` applies when required nullable telemetry is absent, stale, or not bound to the current completed request. Offline or stale state is not assumed healthy.

`NOT_READY` applies to any known blocker, including missing capability, applied-revision mismatch, an unmet pause gate, an active batch, unresolved manual/backfill work, nonzero pending or failed queue, incomplete/failed request, reconciliation mismatch, relevant unresolved quarantine coverage, or a current relevant Agent/Central error.

`READY` requires both capabilities, matching active policy revision, no active batch or unresolved request, fresh pending and failed counts of zero, a completed current request with reconciliation gap zero, completed request-specific coverage processing, and no current relevant error. Quarantine outside the authorized range remains visible but does not by itself block the current range. Plan completion and movement to another Agent remain explicit owner actions.

## 10. Security, RBAC, and audit

Only an active `SUPER_ADMIN` may request, cancel, or resolve/supersede historical work. Central trusts authenticated Agent identity; it never trusts frontend facility identity and never infers facility from IP or MAC. Capability requirements are `remoteSyncStartDate` and `idempotentUploadChunk`.

Every request and lifecycle/plan transition records Agent, server-derived facility, policy revision, exact range, actor, reason, result/status, and timestamp. Audit and errors contain no patient payload, JHCIS credential, Agent credential, or other secret. The scoped pause exception does not weaken the general pause barrier or facility isolation.

## 11. Focused acceptance tests

Focused tests must demonstrate:

- a policy date change or activation alone starts no backfill;
- only `SUPER_ADMIN` can act and facility identity is derived server-side;
- the two capabilities, applied revision, pause state, plan/range, batch, manual-request, and known queue gates are enforced;
- concurrent requests cannot create more than one fleet-wide open request;
- terminal states are immutable and a later attempt receives a new ID;
- legacy `syncRequested*` cleanup is atomic with terminal transitions;
- the existing manual-range path is used while ordinary manual-range behavior is unchanged;
- only the exact linked request/batch receives the narrow pause exception;
- restart and duplicate delivery preserve request, batch, chunk, and receipt identity;
- retryable network failure keeps the request open; protocol conflict fails safely;
- reconciliation is required for completion and historical execution changes neither watermark;
- quarantine files and payloads are preserved, coverage is post-proof and idempotent, and partial/non-covered entries remain unresolved;
- missing/stale telemetry and older-request evidence produce `UNKNOWN`/`NOT_READY`;
- active batch, unresolved request, pending/failed queue, reconciliation mismatch, relevant coverage gap, and current errors block readiness;
- a fully clean, current, matching Agent becomes `READY`.

Run only focused tests and checks for affected surfaces during implementation. Live JHCIS tests and the full suite are outside this phase's verification scope.

## 12. Explicitly out of scope

Phase E does not add automatic or fleet-wide backfill, automatic Agent resume, quarantine deletion or retention changes, automatic quarantine rehydration, RU telemetry, purge redesign, a new queue/update transport, JHCIS writes or schema changes, release/tag/publish work, deployment, or unrelated refactoring.
