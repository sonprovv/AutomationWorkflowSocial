import { useEffect, useState } from 'react';
import { api, type ExportRow, type Job, type JobStats, type Provider, type Workflow } from '../api.ts';
import { ACTIVE, Empty, errText, ErrorBox, fmtTime, Status, useLoad } from '../ui.tsx';

/* ---------------- Job Monitor ---------------- */
export function Jobs() {
  const list = useLoad(() => api<{ items: Job[] }>('/jobs?limit=100'), []);
  const stats = useLoad(() => api<JobStats>('/jobs/stats'), []);
  useEffect(() => {
    const t = setInterval(() => (list.reload(), stats.reload()), 3000);
    return () => clearInterval(t);
  }, [list.reload, stats.reload]);
  async function act(id: string, action: 'cancel' | 'retry') {
    await api(`/jobs/${id}/${action}`, { method: 'POST' }).catch(() => {});
    list.reload();
  }
  const s = stats.data;
  return (
    <>
      <h2>Job Monitor</h2>
      <ErrorBox error={list.error ?? stats.error} />
      {s && (
        <div className="grid2">
          <section>
            <h3>Last 24 h</h3>
            <p>
              {Object.entries(s.byStatus).map(([k, n]) => (
                <span key={k} style={{ marginRight: 12 }}>
                  <Status s={k} /> {n}
                </span>
              ))}
              {Object.keys(s.byStatus).length === 0 && <span className="muted">No jobs.</span>}
            </p>
            <table>
              <tbody>
                {Object.entries(s.byName).map(([name, by]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="small">
                      {Object.entries(by)
                        .map(([k, n]) => `${k} ${n}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.active.some((j) => j.stuck) && <div className="notice">Stuck jobs: {s.active.filter((j) => j.stuck).map((j) => j.id.slice(0, 8)).join(', ')} (running longer than 1.5 × job timeout).</div>}
          </section>
          <section>
            <h3>Dead letter (failed, 24 h)</h3>
            <p className="small">
              {Object.entries(s.deadLetter.byErrorCode)
                .map(([k, n]) => `${k} × ${n}`)
                .join(' · ') || <span className="muted">none</span>}
            </p>
            <table>
              <tbody>
                {s.deadLetter.recent.map((j) => (
                  <tr key={j.id}>
                    <td className="small">{fmtTime(j.finishedAt)}</td>
                    <td>{j.name}</td>
                    <td className="small">
                      {j.errorCode}: {j.errorMessage?.slice(0, 160)}
                    </td>
                    <td>
                      <button onClick={() => act(j.id, 'retry')}>Retry</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
      <h3>Recent jobs</h3>
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Job</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Attempts</th>
            <th>Error / warnings</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((j) => (
            <tr key={j.id}>
              <td className="small">{fmtTime(j.createdAt)}</td>
              <td>
                {j.name} <span className="muted small">{j.id.slice(0, 8)}</span>
              </td>
              <td>
                <Status s={j.status} />
              </td>
              <td>{j.progress}%</td>
              <td>
                {j.attempts}/{j.maxAttempts}
              </td>
              <td className="small">{[j.error ? `${j.error.code}: ${j.error.message ?? ''}` : '', ...j.warnings.slice(0, 2)].filter(Boolean).join(' · ')}</td>
              <td>
                {ACTIVE.includes(j.status) && <button onClick={() => act(j.id, 'cancel')}>Cancel</button>}
                {['FAILED', 'CANCELLED', 'PARTIAL_SUCCESS'].includes(j.status) && <button onClick={() => act(j.id, 'retry')}>Retry</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ---------------- Automations ---------------- */
export function Workflows() {
  const list = useLoad(() => api<{ paused: boolean; items: Workflow[] }>('/workflows'), []);
  const [msg, setMsg] = useState<string | null>(null);
  async function call(path: string, method: string, body?: unknown) {
    try {
      const r = await api<{ status?: string; notes?: string[] }>(path, { method, body });
      if (r?.status) setMsg(`${r.status} ${(r.notes ?? []).join(' ')}`);
      list.reload();
    } catch (x) {
      setMsg(errText(x));
    }
  }
  return (
    <>
      <div className="row">
        <h2 style={{ margin: 0 }}>Automations</h2>
        {list.data?.paused ? (
          <>
            <Status s="PAUSED" /> <button onClick={() => call('/scheduler/resume', 'POST')}>Resume scheduler</button>
          </>
        ) : (
          <button onClick={() => call('/scheduler/pause', 'POST')}>Pause all schedules</button>
        )}
      </div>
      {msg && <p className="small">{msg}</p>}
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Schedule</th>
            <th>Next run</th>
            <th>Last run</th>
            <th>Enabled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((w) => (
            <tr key={w.id}>
              <td>
                {w.workflowKey}
                <div className="muted small">{w.description}</div>
              </td>
              <td className="small">
                {w.cron ? (
                  `cron ${w.cron} (${w.timezone})`
                ) : (
                  <>
                    every{' '}
                    <input
                      className="narrow"
                      style={{ width: 70 }}
                      type="number"
                      min={1}
                      defaultValue={w.everyMinutes ?? 60}
                      onBlur={(e) => Number(e.target.value) !== w.everyMinutes && call(`/workflows/${w.id}`, 'PATCH', { everyMinutes: Number(e.target.value) })}
                    />{' '}
                    min
                  </>
                )}
              </td>
              <td className="small">{w.enabled ? fmtTime(w.nextRunAt) : '—'}</td>
              <td className="small">
                {fmtTime(w.lastRunAt)} <Status s={w.lastStatus} />
                {w.lastResult?.notes?.length ? <div className="muted">{w.lastResult.notes.slice(0, 2).join(' · ')}</div> : null}
              </td>
              <td>
                <input type="checkbox" checked={w.enabled} onChange={(e) => call(`/workflows/${w.id}`, 'PATCH', { enabled: e.target.checked })} />
              </td>
              <td>
                <button onClick={() => call(`/workflows/${w.id}/run`, 'POST')}>Run now</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Missed runs while the computer was off run once on the next start (no replay). Schedules never start duplicate work: an identical active job makes the run SKIPPED.</p>
    </>
  );
}

/* ---------------- Exports ---------------- */
export function Exports() {
  const list = useLoad(() => api<{ items: ExportRow[] }>('/exports'), []);
  return (
    <>
      <h2>Exports</h2>
      <p className="muted small">Create exports from the Content Explorer. Files expire after the configured number of days.</p>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Format</th>
            <th>Status</th>
            <th>Rows</th>
            <th>Withheld by policy</th>
            <th>File</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((e) => (
            <tr key={e.id}>
              <td className="small">{fmtTime(e.createdAt)}</td>
              <td>{e.format}</td>
              <td>
                <Status s={e.status} />
                {e.error && <div className="error-inline small">{e.error}</div>}
              </td>
              <td className="small">{Object.entries(e.rowCounts).map(([k, n]) => `${k} ${n}`).join(' · ')}</td>
              <td className="small">{e.withheld.length ? e.withheld.map((w) => `${w.providerId}: ${w.posts} post(s), ${w.accounts} account(s)`).join('; ') : '—'}</td>
              <td className="small">
                {e.downloadUrl ? <a href={e.downloadUrl}>{e.fileName}</a> : '—'} {e.sizeBytes ? `(${Math.ceil(e.sizeBytes / 1024)} KB)` : ''}
                <div className="muted">expires {fmtTime(e.expiresAt)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <Empty>No exports yet.</Empty>}
    </>
  );
}

/* ---------------- Data Sources ---------------- */
export function Sources() {
  const health = useLoad(() => api<{ status: string; queueDriver: string }>('/health/ready').catch(() => ({ status: 'not_ready', queueDriver: '?' })), []);
  const providers = useLoad(() => api<{ items: Provider[] }>('/providers'), []);
  const [testing, setTesting] = useState<string | null>(null);
  return (
    <>
      <h2>Data Sources</h2>
      {health.data && (
        <p>
          System <Status s={health.data.status === 'ready' ? 'SUCCEEDED' : 'FAILED'} /> · queue <code>{health.data.queueDriver}</code>
          {health.data.queueDriver === 'inline' && <span className="muted"> — dev mode: jobs and schedules run inside the API. Install Redis/Memurai for the separate worker.</span>}
        </p>
      )}
      <ErrorBox error={providers.error} />
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Platform</th>
            <th>Phase 0 status</th>
            <th>Enabled</th>
            <th>Policy</th>
            <th>Usage today</th>
            <th>Health</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {providers.data?.items.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td>{p.platform}</td>
              <td>
                <Status s={p.status} />
              </td>
              <td>{p.enabled ? 'yes' : p.implemented ? (p.credentialConfigured === false ? 'no (credential missing)' : 'no (not verified)') : 'no adapter'}</td>
              <td className="small">
                history {p.policy.allowHistoricalSnapshots ? '✓' : '✗'} · derived {p.policy.allowDerivedMetrics ? '✓' : '✗'} · export {p.policy.allowExport ? '✓' : '✗'}
                {p.policy.retentionDays ? ` · keep ≤${p.policy.retentionDays}d` : ''}
              </td>
              <td className="small">{p.usageToday ? Object.entries(p.usageToday).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—'}</td>
              <td className="small">
                {p.lastHealth ? (p.lastHealth.healthy ? 'healthy' : 'unhealthy') : '—'} {p.checkedAt ? `(${fmtTime(p.checkedAt)})` : ''}
              </td>
              <td>
                {p.implemented && (
                  <button
                    disabled={testing === p.id}
                    onClick={async () => {
                      setTesting(p.id);
                      await api(`/providers/${p.id}/test`, { method: 'POST' }).catch(() => {});
                      setTesting(null);
                      providers.reload();
                    }}
                  >
                    {testing === p.id ? 'Testing…' : 'Test'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">✗ means not allowed until the Product Owner approves the provider policy (deny-by-default). Exports leave such rows out and say so.</p>
    </>
  );
}
