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

## Global Sync Start Date

The Phase B–E architecture is implemented in source but has not been deployed or published. Treat
`PROJECT_SPEC.md` §36, `docs/GLOBAL_SYNC_BACKFILL.md`, and the relevant sections of
`docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/SYNC.md`, `docs/AGENT.md`,
`docs/SECURITY.md`, and `docs/DEPLOYMENT.md` as the shared source of truth. Do not duplicate or
redefine that protocol here.

Preserve legacy operation when no policy exists, keep desired policy separate from active
enforcement and pause control, preserve all Central history and Agent state, and keep purge
separate. Forward operation must remain compatible with older Agents; historical backfill requires
an explicit one-Agent request and the approved idempotent chunk gate. The published `v1.1.16`
release/tag is immutable; `v1.1.17` is a local/unpublished Dev build, `v1.1.18` is published, and
the controlled-update test version is `v1.1.19` until owner review authorizes any release action.
