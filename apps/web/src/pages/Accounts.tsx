import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Account, type AccountDetail, type Job, type Page, type Post, type Project } from '../api.ts';
import { ErrorBox, ExternalLink, fmtNum, fmtTime, Status, useLoad } from '../ui.tsx';

export function Accounts() {
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
        <button type="submit" className="primary" disabled={busy}>
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

export function AccountPage({ id }: { id: string }) {
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
  async function refresh() {
    setErr(null);
    try {
      const r = await api<{ job: Job }>(`/accounts/${id}/refresh-metrics`, { method: 'POST', body: {} });
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
            <button className="primary" onClick={sync} disabled={!!job && ['QUEUED', 'RUNNING'].includes(job.status)}>
              Sync now
            </button>
            <button onClick={refresh} disabled={!!job && ['QUEUED', 'RUNNING'].includes(job.status)}>
              Refresh metrics
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
