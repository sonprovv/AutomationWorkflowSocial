# ADR-0002: Run TypeScript sources directly in Phase 0 (tsx + Vitest, no build step)

- **Status:** Accepted. To be revisited in Phase 1 for the `apps/*` Docker images.
- **Date:** 2026-11-26
- **Phase:** 0

## Context
Phase 0 delivers libraries and a CLI harness. A build step adds friction across platforms and creates a risk of running a stale `dist/`.

## Decision
- Workspace packages export `./src/index.ts` directly: `"exports": {".": "./src/index.ts"}`.
- The CLI runs with **tsx**. Tests run with **Vitest**. Type checking uses `tsc --noEmit` with TypeScript 7.0.2, `strict` mode and `noUncheckedIndexedAccess`.
- Code is ESM only. Imports carry explicit `.ts` extensions, enabled by `allowImportingTsExtensions` and `verbatimModuleSyntax`.

## Consequences
- After `npm ci`, `npm run poc`, `npm test` and `npm run typecheck` work on both Windows and macOS.
- The Phase 1 Docker images for `apps/api` and `apps/worker` need either a bundle step (tsup or esbuild) or tsx at runtime. A Phase 1 ADR will decide which.
