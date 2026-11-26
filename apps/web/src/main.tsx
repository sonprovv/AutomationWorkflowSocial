import { StrictMode, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, type Account, type AccountDetail, type Job, type Page, type Post, type Project, type Provider } from './api.ts';
import './styles.css';

/*
 * Phase 1 minimal UI (vertical slice: URL → real data → DB → UI). The full dashboard, Content Explorer,
 * Tailwind/shadcn design system and charts are Phase 5. Rules already applied here: every number shows
 * its source and collection time; missing values render as "—" with the reason (never 0); external links
 * open safely; captions render as text (no HTML).
 */

type Route = { page: 'overview' } | { page: 'projects' } | { page: 'accounts' } | { page: 'account'; id: string } | { page: 'jobs' };

function parseHash(): Route {
  const [page, id] = location.hash.replace(/^#\/?/, '').split('/');
  if (page === 'account' && id) return { page: 'account', id };
  if (page === 'projects' || page === 'accounts' || page === 'jobs') return { page };
  return { page: 'overview' };
}

const fmtNum = (v: number | null | undefined, reason?: string) =>
  v === null || v === undefined ? <span className="muted" title={reason ? `Missing: ${reason}` : 'Not provided'}>—</span> : v.toLocaleString();
const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https:\/\//.test(href) ? href : undefined;
  return safe ? (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function Status({ s }: { s: string }) {
  return <span className={`badge badge-${s.toLowerCase()}`}>{s}</span>;
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    fn().then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e: unknown) => setError(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error">{error}</div> : null;
}

/* ---------------- pages ---------------- */

function Overview() {
  const health = useLoad(() => api<{ status: string; queueDriver: string; checks: Record<string, { ok: boolean; error?: string }> }>('/health/ready').catch((e) => (e instanceof ApiError ? { status: 'not_ready', queueDriver: '?', checks: {} } : Promise.reject(e))), []);
  const providers = useLoad(() => api<{ items: Provider[] }>('/providers'), []);
  const [testing, setTesting] = useState<string | null>(null);
  return (
    <>
      <h2>Overview</h2>
      <ErrorBox error={health.error ?? providers.error} />
      {health.data && (
        <p>
          System: <Status s={health.data.status === 'ready' ? 'SUCCEEDED' : 'FAILED'} /> queue driver <code>{health.data.queueDriver}</code>
          {health.data.queueDriver === 'inline' && <span className="muted"> — dev mode: install Redis/Memurai to enable the worker and schedules.</span>}
        </p>
      )}
      <h3>Data sources</h3>
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
              <td className="small">{p.lastHealth ? (p.lastHealth.healthy ? 'healthy' : 'unhealthy') : '—'} {p.checkedAt ? `(${fmtTime(p.checkedAt)})` : ''}</td>
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
    </>
  );
}

function Projects() {
  const list = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/projects', { method: 'POST', body: { name } });
      setName('');
      list.reload();
    } catch (x) {
      setErr(x instanceof ApiError ? `${x.code}: ${x.message}` : String(x));
    }
  }
  return (
    <>
      <h2>Projects</h2>
      <form onSubmit={create} className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name, e.g. Depth Clock Wallpaper" required maxLength={200} />
        <button type="submit">Create project</button>
      </form>
      <ErrorBox error={err ?? list.error} />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Accounts</th>
            <th>Timezone</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>
                <Status s={p.status} />
              </td>
              <td>{p.accountCount ?? '—'}</td>
              <td>{p.timezone}</td>
              <td>{fmtTime(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <p className="muted">No projects yet.</p>}
    </>
  );
}

function Accounts() {
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [projectId, setProjectId] = useState('');
  const list = useLoad(() => api<Page<Account>>(`/accounts?limit=100${projectId ? `&projectId=${projectId}` : ''}`), [projectId]);
  const [input, setInput] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function track(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ account: Account; job_id: string | null; warnings: string[] }>('/accounts', { method: 'POST', body: { input, ...(projectId ? { projectId } : {}) } });
      setMsg({ kind: 'ok', text: `Tracked ${r.account.username ?? r.account.externalId}. Sync job ${r.job_id ?? '—'} queued. ${r.warnings.join(' ')}` });
      setInput('');
      list.reload();
    } catch (x) {
      setMsg({ kind: 'err', text: x instanceof ApiError ? `${x.code}: ${x.message}` : String(x) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>Accounts</h2>
      <form onSubmit={track} className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Profile URL, e.g. https://bsky.app/profile/bsky.app" required maxLength={500} />
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">(no project)</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          {busy ? 'Resolving…' : 'Track account'}
        </button>
      </form>
      {msg && <div className={msg.kind === 'ok' ? 'ok' : 'error'}>{msg.text}</div>}
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Platform</th>
            <th>Status</th>
            <th>Followers</th>
            <th>Posts</th>
            <th>Collected</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((a) => (
            <tr key={a.id}>
              <td>
                <a href={`#/account/${a.id}`}>{a.displayName ?? a.username ?? a.externalId}</a> <span className="muted small">@{a.username}</span>
              </td>
              <td>{a.platform}</td>
              <td>
                <Status s={a.status} />
              </td>
              <td>{fmtNum(a.metrics?.followers, a.metrics?.missing?.followers)}</td>
              <td>{fmtNum(a.metrics?.postsCount, a.metrics?.missing?.postsCount)}</td>
              <td className="small">
                {fmtTime(a.metrics?.collectedAt ?? a.provenance.lastCollectedAt)} · {a.provenance.providerId}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <p className="muted">No accounts yet — paste a profile URL above.</p>}
    </>
  );
}

function AccountPage({ id }: { id: string }) {
  const acc = useLoad(() => api<AccountDetail>(`/accounts/${id}`), [id]);
  const posts = useLoad(() => api<Page<Post>>(`/posts?accountId=${id}&limit=50`), [id]);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!job || !['QUEUED', 'RUNNING'].includes(job.status)) return;
    const t = setTimeout(async () => {
      const j = await api<Job>(`/jobs/${job.id}`);
      setJob(j);
      if (!['QUEUED', 'RUNNING'].includes(j.status)) {
        acc.reload();
        posts.reload();
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [job, acc, posts]);

  async function sync() {
    setErr(null);
    try {
      const r = await api<{ job: Job }>(`/accounts/${id}/sync`, { method: 'POST', body: {} });
      setJob(r.job);
    } catch (x) {
      if (x instanceof ApiError && x.code === 'CONFLICT' && typeof x.details?.jobId === 'string') setJob(await api<Job>(`/jobs/${x.details.jobId}`));
      else setErr(x instanceof ApiError ? `${x.code}: ${x.message}` : String(x));
    }
  }
  const a = acc.data;
  return (
    <>
      <p>
        <a href="#/accounts">← Accounts</a>
      </p>
      <ErrorBox error={acc.error ?? posts.error ?? err} />
      {a && (
        <>
          <div className="profile">
            {a.avatarUrl && <img src={a.avatarUrl} alt="" referrerPolicy="no-referrer" width={64} height={64} />}
            <div>
              <h2>
                {a.displayName ?? a.username} <Status s={a.status} />
              </h2>
              <div className="muted small">
                {a.platform} · <ExternalLink href={a.profileUrl}>{a.username ?? a.externalId}</ExternalLink> · ID <code>{a.externalId}</code>
              </div>
              {a.bio && <p className="bio">{a.bio}</p>}
            </div>
          </div>
          <div className="stats">
            <div>
              <b>{fmtNum(a.metrics?.followers, a.metrics?.missing?.followers)}</b> followers
            </div>
            <div>
              <b>{fmtNum(a.metrics?.following, a.metrics?.missing?.following)}</b> following
            </div>
            <div>
              <b>{fmtNum(a.metrics?.postsCount, a.metrics?.missing?.postsCount)}</b> posts on platform
            </div>
            <div>
              <b>{a.postCount}</b> posts stored
            </div>
          </div>
          <p className="muted small">
            Metrics collected {fmtTime(a.metrics?.collectedAt)} via {a.metrics?.providerId ?? '—'} (policy {a.metrics?.policyId ?? '—'}). Last successful sync {fmtTime(a.sync?.lastSuccessAt)}.
          </p>
          <div className="row">
            <button onClick={sync} disabled={!!job && ['QUEUED', 'RUNNING'].includes(job.status)}>
              Sync now
            </button>
            {job && (
              <span>
                Job <Status s={job.status} /> {job.progress}% {job.error && <span className="error-inline">{job.error.code}: {job.error.message}</span>}
                {job.result && ` · ${String(job.result.postsNew ?? 0)} new, ${String(job.result.postsUpdated ?? 0)} updated`}
              </span>
            )}
          </div>
          <h3>Posts</h3>
          <table>
            <thead>
              <tr>
                <th>Published</th>
                <th>Type</th>
                <th>Content</th>
                <th>Views</th>
                <th>Likes</th>
                <th>Comments</th>
                <th>Shares</th>
                <th>Collected</th>
              </tr>
            </thead>
            <tbody>
              {posts.data?.items.map((p) => (
                <tr key={p.id}>
                  <td className="small">{fmtTime(p.publishedAt)}</td>
                  <td>{p.contentType}</td>
                  <td className="caption">
                    <ExternalLink href={p.url}>{p.title ?? (p.caption ? p.caption.slice(0, 160) : '(no text)')}</ExternalLink>
                    {p.hashtags.length > 0 && <div className="muted small">#{p.hashtags.join(' #')}</div>}
                  </td>
                  <td>{fmtNum(p.metrics?.views, p.metrics?.missing?.views)}</td>
                  <td>{fmtNum(p.metrics?.likes, p.metrics?.missing?.likes)}</td>
                  <td>{fmtNum(p.metrics?.comments, p.metrics?.missing?.comments)}</td>
                  <td>{fmtNum(p.metrics?.shares, p.metrics?.missing?.shares)}</td>
                  <td className="small">{fmtTime(p.metrics?.collectedAt ?? p.provenance.lastCollectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {posts.data?.items.length === 0 && <p className="muted">No posts stored yet — run a sync.</p>}
          <h3>Sync history</h3>
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Operation</th>
                <th>Status</th>
                <th>Requests</th>
                <th>Records</th>
                <th>Latency</th>
                <th>Error / warnings</th>
              </tr>
            </thead>
            <tbody>
              {a.recentRuns.map((r) => (
                <tr key={r.id}>
                  <td className="small">{fmtTime(r.startedAt)}</td>
                  <td>{r.operation}</td>
                  <td>
                    <Status s={r.status} />
                  </td>
                  <td>{r.requests}</td>
                  <td>{r.records}</td>
                  <td>{r.latencyMs ?? '—'} ms</td>
                  <td className="small">{[r.errorCode, ...r.warnings].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function Jobs() {
  const list = useLoad(() => api<{ items: Job[] }>('/jobs?limit=100'), []);
  useEffect(() => {
    const t = setInterval(list.reload, 3000);
    return () => clearInterval(t);
  }, [list.reload]);
  async function act(id: string, action: 'cancel' | 'retry') {
    await api(`/jobs/${id}/${action}`, { method: 'POST' }).catch(() => {});
    list.reload();
  }
  return (
    <>
      <h2>Jobs</h2>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Job</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Attempts</th>
            <th>Error</th>
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
              <td className="small">{j.error ? `${j.error.code}: ${j.error.message ?? ''}` : ''}</td>
              <td>
                {['QUEUED', 'RUNNING'].includes(j.status) && <button onClick={() => act(j.id, 'cancel')}>Cancel</button>}
                {['FAILED', 'CANCELLED', 'PARTIAL_SUCCESS'].includes(j.status) && <button onClick={() => act(j.id, 'retry')}>Retry</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const nav: [Route['page'], string][] = [
    ['overview', 'Overview'],
    ['projects', 'Projects'],
    ['accounts', 'Accounts'],
    ['jobs', 'Jobs'],
  ];
  return (
    <>
      <header>
        <b>Social Spy Automation</b>
        <nav>
          {nav.map(([p, label]) => (
            <a key={p} href={`#/${p}`} className={route.page === p || (p === 'accounts' && route.page === 'account') ? 'active' : ''}>
              {label}
            </a>
          ))}
          <a href="/api/docs" target="_blank" rel="noopener noreferrer">
            API docs
          </a>
        </nav>
      </header>
      <main>
        {route.page === 'overview' && <Overview />}
        {route.page === 'projects' && <Projects />}
        {route.page === 'accounts' && <Accounts />}
        {route.page === 'account' && <AccountPage id={route.id} />}
        {route.page === 'jobs' && <Jobs />}
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
