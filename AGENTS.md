# Project Instructions

This repository is the Sankamphaeng Drug Data Center.

Before making any changes, read:

1. PROJECT_SPEC.md
2. JHCIS_INTEGRATION.md

These files contain the authoritative project requirements and architecture.

## Important Rules

- Do not violate the architecture defined in PROJECT_SPEC.md.
- Do not change JHCISDB structure.
- JHCISDB must always be treated as READ-ONLY.
- Never expose JHCISDB credentials.
- Never commit secrets to Git.
- Never bypass facility isolation.
- Never trust facility_id supplied by the frontend.
- Agent identity must be authenticated server-side.
- Do not guess JHCISDB schema.
- Inspect the actual JHCISDB schema before implementing JHCIS extraction.
- Preserve existing business logic unless explicitly instructed otherwise.

When requirements are unclear, inspect the existing code and documentation first.

When implementing JHCIS integration, JHCIS_INTEGRATION.md takes precedence for JHCIS-specific requirements.

Before completing a task:

- run lint
- run typecheck
- run tests if available
- run production build
- review git diff
- ensure no secrets or credentials are committed

## Codex and Claude Code Coexistence

This repository must remain usable with both Codex and Claude Code. Before major work, read
`CLAUDE.md` for historical/project guidance and the relevant shared documentation. Never delete,
rename, overwrite, or replace `CLAUDE.md` with this file.

Use the existing documentation as the navigation map:

- `PROJECT_SPEC.md` — authoritative platform requirements and architecture.
- `JHCIS_INTEGRATION.md` — authoritative JHCIS-specific requirements.
- `docs/ARCHITECTURE.md` — deployed component boundaries and data flow.
- `docs/API.md`, `docs/DATABASE.md`, and `docs/SYNC.md` — API, Central schema, and sync contracts.
- `docs/AGENT.md`, `agent/installer/README.md` — Agent operation, installation, and upgrades.
- `docs/SECURITY.md`, `docs/DEPLOYMENT.md` — security and production procedures.

Prefer the existing architecture over parallel subsystems. If code and documentation disagree,
or an architectural decision is ambiguous, stop and report the evidence instead of guessing.

## Data and Identity Safety

- JHCIS is a source of truth and is strictly read-only. Never issue `INSERT`, `UPDATE`, `DELETE`,
  `TRUNCATE`, `ALTER`, `DROP`, `CREATE`, or `REPLACE` against JHCIS. Inspect the actual schema
  before changing extraction behavior, and never expose credentials or patient payloads.
- Derive facility scope from the authenticated server-side user or Agent identity. Never trust a
  frontend `facility_id`, and never infer facility identity from IP or MAC address.
- Destructive Central/TiDB operations require explicit owner approval and an exact scope. Preserve
  users, roles, facilities, Agent identities and credentials, enrollment state, control history,
  audit history, and production-derived data unless explicitly authorized otherwise.

## Agent Release and Update Safety

- Published releases and tags are immutable. Create a new version for every change.
- Preserve the current `agentId` + credential + facility enrollment model and normal-upgrade
  continuity. Upgrades must retain `%ProgramData%\SDCAgent`, credentials, state, and queued work.
- Preserve the authenticated heartbeat, pause/resume, sync queue, and update-command protocols.
  Never globally terminate `node.exe` or `SDCAgent.exe`; use the repository's owned-process logic.

## Git and Verification

Before editing, verify the repository root, `main` branch, `origin`, `HEAD`, `origin/main`, clean
working tree, and repo-local `user.name`/`user.email`. Stop on unexpected state; do not auto-stash,
reset, clean, switch branches, or rewrite credentials. Never force-push `main`, and never use
`git push --no-verify` without explicit owner approval.

When source, Agent, or build behavior changes, run `npm run lint`, `npm run typecheck`, `npm test`,
and `npm run build`; also run `npm --prefix agent run typecheck` and relevant Agent/GUI checks.
Review the final diff and confirm it contains no secrets before any commit.

## Planned Global Sync Start Date

Do not implement this without a separate approved task. The intended direction is one global date,
controlled only by `SUPER_ADMIN` in Central and sent to every Agent for durable application. A date
change must not delete existing Central history; moving it backward may require targeted,
idempotent backfill, while moving it forward must not remove stored rows. Keep the existing
SUPER_ADMIN deletion workflow separate, prevent duplicates, preserve backward compatibility, and
use the existing pause/resume controls for staged rollout.
