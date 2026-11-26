# ADR-0001: Repository layout and package manager

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 0

## Context
Master Plan §14 shows the project tree under a `social-spy-automation/` folder. The working folder (`D:\web\SpySocial`) and its Git remote already belong to this project alone. pnpm is not installed on the development machine. npm ships with Node.js on Windows and macOS.

## Decision
- The repository root is the `social-spy-automation/` root. There is no extra nested folder.
- Packages are managed with **npm workspaces** (`packages/collectors/*` and `tools/*` now; `apps/*` and more `packages/*` come in Phase 1). `package-lock.json` is committed.
- Dependency versions are pinned exactly.
- Node version is `>=22.12 <25`; `.nvmrc` pins 22.
- Phase 0 creates only the parts of the §14 tree that Phase 0 uses:
  - `packages/collectors/{core,bluesky,youtube}`
  - `tools/feasibility`
  - `tests/fixtures`
  - `docs/feasibility`
  - `docs/adr`

## Consequences
- Node.js is the only global tool needed. The same commands work in Windows PowerShell, Git Bash and macOS zsh.
- Switching to pnpm later requires a new ADR and a regenerated lockfile. Package boundaries stay the same.
