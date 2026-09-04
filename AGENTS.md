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