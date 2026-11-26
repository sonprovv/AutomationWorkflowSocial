# ADR-0017: Versioned workflow DAG builder and SVG editor

- **Status:** Accepted
- **Date:** 2026-11-27
- **Phase:** 9 (P9-01, P9-02)

## Context
Master Plan §10.3 asks for a visual workflow builder after the MVP. The built-in automations (Phase 4) are fixed workflows with a schedule. Users want to chain the existing jobs (discovery, sync, metrics, viral, trends, AI, export, report, notify) in their own order, with waits and conditions, without introducing arbitrary code execution or new collectors.

## Decision

### 1. Engine (P9-01)
- **Tables:** `workflow_defs` (name, project, status, current version), `workflow_versions` (immutable JSON graph) and `workflow_runs` (per-node steps).
- **Versions:** every save creates a new version, and every run pins one. Restoring an old version means saving its graph again as a new version, so history never changes.
- **Validation:** `validateGraph` is the only gate. It checks that:
  - node types come from a whitelist, and each config matches its schema;
  - there is exactly one start node, with no incoming edges;
  - the graph is acyclic (Kahn sort) and every node is reachable from the start;
  - only if-nodes have `true`/`false` edges;
  - total wait time is at most 3600 s.
- **Execution:** the `workflow.run` job walks the graph in topological order. Each node queues the same guarded job the UI or API would, so dedup, budgets and policy gates still apply. Each node has a timeout and an `onError` setting (`stop`/`continue`). Cancelling the run cancels its child jobs.
- **API:** `/api/v1/workflow-defs`:
  - node types, list, create, get and graph;
  - validate, save a version, read a version (`/versions/:version`);
  - `PATCH` for name, description, project and status;
  - run, and the list of runs.

### 2. Editor (P9-02)
- **A small SVG editor written for this app, not React Flow.** `@xyflow/react` 13.0.3 was released on 2026-11-23, which is newer than our 2-week dependency rule allows. An older 12.x release would have been allowed, but:
  - graphs are capped at 50 nodes and 100 edges;
  - the Product Owner prefers lightweight setups;
  - the editor needs only move, connect, select and delete.

  About 1,100 lines of code, with no new dependency and no extra supply-chain surface, cover this.
- **Editing logic** lives in `apps/web/src/graph-edit.ts`: pure functions with unit tests. It blocks obvious mistakes as they are made:
  - self-loops, duplicate edges, cycles and edges into the start node;
  - when an edge leaves an if-node, it is labelled `true` first, then `false`.

  The server stays the source of truth: the Validate and Save buttons call it.
- **Node settings forms** are generated from each node type's JSON Schema, which `/workflow-defs/node-types` serves. Adding a node type on the server needs no UI change.
- **Run status:** when a run is selected, each node is coloured by its step status. The run list is polled while a run is in progress.

## Consequences
- **Static files:** the API registers files in `apps/web/dist` at startup (`wildcard: false`). After `npm run build:web`, restart the app, or the new bundle returns 404. This was already the case and is now noted in RUNBOOK and NEXT_STEPS.
- **Recurring runs** use a `CUSTOM_WORKFLOW` schedule (Phase 4 scheduler). The editor does not edit schedules.
- **No browser test framework is installed.** The editor was checked in headless Edge over the DevTools protocol: add a node, drag-connect, move, a rejected edge into the start node, validate, then save, confirmed via the API. This check is a one-off script, not part of `npm test`.

## Alternatives considered
- **React Flow 12.x (pinned).** A good library, but heavier than this scope needs. Revisit if the editor needs minimap, zoom/pan, grouping or auto-layout beyond columns.
- **Editing JSON in a textarea.** Rejected: not a visual editor, and easy to get wrong.
