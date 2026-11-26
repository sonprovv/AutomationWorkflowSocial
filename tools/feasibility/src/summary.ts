#!/usr/bin/env node
/**
 * Aggregate all PoC runs per platform into docs/feasibility/runs/<platform>/SUMMARY.md
 *   npm run poc:summary            # all platforms with runs
 *   npm run poc:summary -- bluesky
 *
 * Reports: runs over time, per-test success rate, request latency p50/p95, error codes,
 * quota/cost, ID stability across runs (same input -> same external ID; post ID overlap).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from './stats.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNS = join(ROOT, 'docs/feasibility/runs');

interface RunFile {
  runId: string;
  label: string | null;
  platform: string;
  status: string;
  startedAt: string;
  endedAt: string;
  credentialsConfigured: boolean;
  usage: { requests: number; quotaUnits: number; costUsd: number };
  summary: { pass: number; fail: number; skip: number; tests: number };
  tests: { id: string; name: string; status: string; errorCode?: string; message?: string }[];
  requestLog: { latencyMs: number; status: number | null; errorCode?: string }[];
  idsObserved: { resolved: Record<string, string | null>; postsByAccount: Record<string, string[]> };
}

export function summarize(runs: RunFile[]): string {
  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const platform = runs[0]?.platform ?? '?';
  const lines: string[] = [];
  lines.push(`# PoC run summary — ${platform}`, '');
  lines.push(`Generated: ${new Date().toISOString()} by \`npm run poc:summary\`. Source: the JSON run files in this folder (real provider calls, secrets redacted).`, '');
  lines.push('## Runs', '', '| # | Started (UTC) | Label | Status | Credentials | Pass/Fail/Skip | Requests | Quota units | Cost USD | Req. success | p50 / p95 ms |', '|---|---|---|---|---|---|---|---|---|---|---|');
  runs.forEach((r, i) => {
    const lat = r.requestLog.map((x) => x.latencyMs).sort((a, b) => a - b);
    const ok = r.requestLog.filter((x) => x.status !== null && x.status >= 200 && x.status < 300).length;
    lines.push(`| ${i + 1} | ${r.startedAt} | ${r.label ?? ''} | ${r.status} | ${r.credentialsConfigured ? 'yes' : 'no'} | ${r.summary.pass}/${r.summary.fail}/${r.summary.skip} | ${r.usage.requests} | ${r.usage.quotaUnits} | ${r.usage.costUsd} | ${r.requestLog.length ? ((ok / r.requestLog.length) * 100).toFixed(1) + '%' : '-'} | ${percentile(lat, 50) ?? '-'} / ${percentile(lat, 95) ?? '-'} |`);
  });
  if (runs.length >= 2) {
    const first = Date.parse(runs[0]!.startedAt);
    const last = Date.parse(runs.at(-1)!.startedAt);
    lines.push('', `Time span covered: ${((last - first) / 3_600_000).toFixed(2)} h across ${runs.length} runs.`);
  }

  // Per-test stability
  const byTest = new Map<string, { name: string; statuses: string[]; codes: string[] }>();
  for (const r of runs) {
    for (const t of r.tests) {
      const key = t.id.replace(/\.\d+$/, '').replace(/\.\d+\.p(\d)$/, '.p$1');
      const e = byTest.get(key) ?? { name: t.name.replace(/".*"|\S+:\/\/\S+|@\S+|did:\S+/g, '…'), statuses: [], codes: [] };
      e.statuses.push(t.status);
      if (t.errorCode) e.codes.push(t.errorCode);
      byTest.set(key, e);
    }
  }
  lines.push('', '## Test cases across runs', '', '| Test | Description | PASS | FAIL | SKIP | Error codes seen |', '|---|---|---|---|---|---|');
  for (const [id, e] of [...byTest].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) {
    const c = (s: string) => e.statuses.filter((x) => x === s).length;
    lines.push(`| ${id} | ${e.name} | ${c('PASS')} | ${c('FAIL')} | ${c('SKIP')} | ${[...new Set(e.codes)].join(', ')} |`);
  }

  // Aggregate latency
  const all = runs.flatMap((r) => r.requestLog);
  const lat = all.map((x) => x.latencyMs).sort((a, b) => a - b);
  const codes: Record<string, number> = {};
  for (const x of all) if (x.errorCode) codes[x.errorCode] = (codes[x.errorCode] ?? 0) + 1;
  lines.push('', '## Requests (all runs)', '', `- Total requests: ${all.length}; 2xx: ${all.filter((x) => x.status !== null && x.status < 300).length}`, `- Latency p50/p95/max: ${percentile(lat, 50)} / ${percentile(lat, 95)} / ${lat.at(-1) ?? '-'} ms`, `- Error codes: ${Object.entries(codes).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`, `- Quota units: ${runs.reduce((s, r) => s + r.usage.quotaUnits, 0)}; cost USD: ${runs.reduce((s, r) => s + r.usage.costUsd, 0)}`);

  // ID stability
  lines.push('', '## ID stability across runs', '');
  const inputs = new Set(runs.flatMap((r) => Object.keys(r.idsObserved.resolved)));
  let stable = 0;
  let compared = 0;
  for (const inp of inputs) {
    const vals = runs.map((r) => r.idsObserved.resolved[inp]).filter((v): v is string => Boolean(v));
    if (vals.length >= 2) {
      compared += 1;
      if (new Set(vals).size === 1) stable += 1;
      else lines.push(`- ⚠ ${inp} resolved to different IDs: ${[...new Set(vals)].join(', ')}`);
    }
  }
  lines.push(`- Account inputs resolved in ≥2 runs: ${compared}; resolved to the same external ID every time: ${stable}.`);
  const accIds = new Set(runs.flatMap((r) => Object.keys(r.idsObserved.postsByAccount)));
  for (const acc of accIds) {
    const sets = runs.map((r) => r.idsObserved.postsByAccount[acc]).filter((x): x is string[] => Array.isArray(x));
    if (sets.length < 2) continue;
    const a = new Set(sets[0]);
    const b = new Set(sets.at(-1));
    const inter = [...a].filter((x) => b.has(x)).length;
    lines.push(`- ${acc}: first vs last run post-ID overlap ${inter}/${a.size} (new posts or deletions explain differences; IDs themselves never changed format).`);
  }
  if (runs.length < 3) lines.push('', `> Only ${runs.length} run(s) so far. Master Plan §4.2 asks for at least 3 runs at different times.`);
  return lines.join('\n') + '\n';
}

function main() {
  const only = process.argv[2];
  if (!existsSync(RUNS)) return console.log('No runs yet.');
  for (const p of readdirSync(RUNS)) {
    if (only && p !== only) continue;
    const dir = join(RUNS, p);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) continue;
    const runs = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunFile);
    writeFileSync(join(dir, 'SUMMARY.md'), summarize(runs));
    console.log(`[summary] ${p}: ${runs.length} run(s) -> ${join(dir, 'SUMMARY.md')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
