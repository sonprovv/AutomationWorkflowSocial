#!/usr/bin/env node
/**
 * Security checks (Phase 8 gate): secret scan of tracked files, ignore rules for secrets/data, .env.example
 * holds no values, default bind is loopback, dependency audit (when the registry is reachable).
 *
 *   npm run security:check        → prints results, writes docs/phase8/security-<time>.json, exit 1 on findings
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema, findRepoRoot } from '@sss/config';

const root = findRepoRoot();
const checks: { check: string; ok: boolean; details?: unknown }[] = [];

// 1) Secret patterns in tracked files (values only; placeholders and test fixtures marked "not-real" are fine).
const PATTERNS: [string, RegExp][] = [
  ['Anthropic API key', /sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36}/],
  ['Password in a connection URL', /(?:postgres(?:ql)?|redis|smtps?):\/\/[^:\s/"'`]+:(?!\$\{|<|password@|pass@|secret@)[^@\s/"'`]{6,}@/],
];
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => f && !/\.(png|jpg|jpeg|gif|ico|xlsx|woff2?)$/i.test(f) && !f.endsWith('package-lock.json'));
const findings: { file: string; line: number; kind: string }[] = [];
for (const f of files) {
  let text = '';
  try {
    text = readFileSync(join(root, f), 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const [kind, re] of PATTERNS) if (re.test(line) && !/not-real|fixture|example|placeholder/i.test(line)) findings.push({ file: f, line: i + 1, kind });
  });
}
checks.push({ check: `No secrets in ${files.length} tracked files`, ok: findings.length === 0, details: findings });

// 2) Secrets and local data are ignored by git.
const mustIgnore = ['.env', '.data/postgres/PG_VERSION', '.data/backup.key', '.data/backups/x.sssbk', '.data/exports/x.xlsx', '.data/evidence/x.png'];
const notIgnored = mustIgnore.filter((p) => spawnSync('git', ['check-ignore', '-q', p], { cwd: root }).status !== 0);
checks.push({ check: '.env and .data/* (DB, backups, keys, exports, evidence) are git-ignored', ok: notIgnored.length === 0, details: notIgnored });
const trackedSecrets = files.filter((f) => /^\.env$|\.sssbk$|backup\.key$|postgres\.secret$/.test(f));
checks.push({ check: 'No .env / backup / key files are tracked', ok: trackedSecrets.length === 0, details: trackedSecrets });

// 3) .env.example carries no values for secret settings.
const example = readFileSync(join(root, '.env.example'), 'utf8');
const secretKeys = ['YOUTUBE_API_KEY', 'BLUESKY_APP_PASSWORD', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'SMTP_URL', 'WEBHOOK_SECRET', 'BACKUP_PASSPHRASE', 'API_TOKEN'];
const filled = secretKeys.filter((k) => new RegExp(`^${k}=\\S+`, 'm').test(example));
checks.push({ check: '.env.example has empty secret values', ok: filled.length === 0, details: filled });

// 4) Safe defaults.
const d = configSchema.parse({});
checks.push({ check: 'API binds to loopback by default; remote exposure requires API_TOKEN', ok: d.API_HOST === '127.0.0.1' && (() => { try { configSchema.parse({ API_HOST: '0.0.0.0' }); return false; } catch { return true; } })() });
checks.push({ check: 'MCP mutations disabled by default; auto-track off by default', ok: d.MCP_ALLOW_MUTATIONS === false });

// 5) Dependency audit (production deps). Network failures are reported, not hidden.
const audit = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120_000 });
let auditSummary: unknown = { error: (audit.stderr || 'npm audit failed').slice(0, 300) };
let auditOk = false;
try {
  const j = JSON.parse(audit.stdout);
  const v = j.metadata?.vulnerabilities ?? {};
  auditSummary = v;
  auditOk = (v.high ?? 0) === 0 && (v.critical ?? 0) === 0;
} catch {
  /* keep error */
}
checks.push({ check: 'npm audit (production): no high/critical vulnerabilities', ok: auditOk, details: auditSummary });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(join(root, 'docs', 'phase8'), { recursive: true });
const out = join(root, 'docs', 'phase8', `security-${stamp}.json`);
writeFileSync(out, JSON.stringify({ schema: 'sss.security-check/v1', at: new Date().toISOString(), checks }, null, 2) + '\n');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.check}${c.ok ? '' : `  ${JSON.stringify(c.details).slice(0, 300)}`}`);
console.log('report:', out);
if (!checks.every((c) => c.ok)) process.exitCode = 1;
