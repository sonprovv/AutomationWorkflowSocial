import { useState } from 'react';
import { api, type ExportRow, type Job, type Page, type PostFull, type Project } from '../api.ts';
import { ACTIVE, Empty, errText, ErrorBox, ExternalLink, fmtNum, fmtTime, Loading, PLATFORMS, Status, useLoad, usePoll } from '../ui.tsx';

type Filters = { projectId: string; platform: string; contentType: string; hashtag: string; q: string; since: string; until: string; includeUnavailable: boolean };
const EMPTY: Filters = { projectId: '', platform: '', contentType: '', hashtag: '', q: '', since: '', until: '', includeUnavailable: false };

function toQuery(f: Filters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.projectId) out.projectId = f.projectId;
  if (f.platform) out.platform = f.platform;
  if (f.contentType) out.contentType = f.contentType;
  if (f.hashtag) out.hashtag = f.hashtag;
  if (f.q) out.q = f.q;
  if (f.since) out.since = new Date(f.since).toISOString();
  if (f.until) out.until = new Date(`${f.until}T23:59:59`).toISOString();
  if (f.includeUnavailable) out.includeUnavailable = 'true';
  return out;
}

/** Export of the current filters (WF17). Polls the job and shows the download link. */
export function ExportButton({ filters }: { filters: Filters }) {
  const [format, setFormat] = useState('xlsx');
  const [job, setJob] = useState<Job | null>(null);
  const [exp, setExp] = useState<ExportRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  usePoll(
    async () => {
      if (!exp) return;
      const e = await api<ExportRow>(`/exports/${exp.id}`);
      setExp(e);
      if (job) setJob(await api<Job>(`/jobs/${job.id}`));
    },
    !!exp && ['QUEUED', 'RUNNING'].includes(exp.status),
    1500,
  );
  async function run() {
    setErr(null);
    try {
      const q = toQuery(filters);
      const { projectId, ...rest } = q;
      const r = await api<{ job: Job; export: ExportRow }>('/exports', { method: 'POST', body: { format, ...(projectId ? { projectId } : {}), filters: { ...rest, ...(rest.includeUnavailable ? { includeUnavailable: true } : {}) } } });
      setJob(r.job);
      setExp(r.export);
    } catch (x) {
      setErr(errText(x));
    }
  }
  return (
    <span className="row" style={{ margin: 0 }}>
      <select value={format} onChange={(e) => setFormat(e.target.value)}>
        <option value="xlsx">Excel (.xlsx)</option>
        <option value="csv">CSV</option>
        <option value="json">JSON</option>
      </select>
      <button onClick={run} disabled={!!exp && ACTIVE.includes(exp.status)}>
        Export these results
      </button>
      {exp && (
        <span className="small">
          <Status s={exp.status} /> {exp.downloadUrl && <a href={exp.downloadUrl}>Download {exp.fileName}</a>}
          {exp.withheld.length > 0 && <span className="notice"> {exp.withheld.map((w) => `${w.posts} post(s) / ${w.accounts} account(s) from ${w.providerId} withheld: export not allowed by policy ${w.policyId}`).join('; ')}</span>}
          {exp.error && <span className="error-inline"> {exp.error}</span>}
        </span>
      )}
      {err && <span className="error-inline">{err}</span>}
    </span>
  );
}

export function Explorer() {
  const initial = { ...EMPTY, ...Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] ?? '')) } as Filters;
  const [draft, setDraft] = useState<Filters>(initial);
  const [filters, setFilters] = useState<Filters>(initial);
  const [pages, setPages] = useState<PostFull[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const list = useLoad(async () => {
    const qs = new URLSearchParams({ ...toQuery(filters), limit: '50', ...(cursor ? { cursor } : {}) });
    const r = await api<Page<PostFull>>(`/posts?${qs}`);
    setPages((prev) => (cursor ? [...prev, ...r.items] : r.items));
    return r;
  }, [filters, cursor]);
  const set = (k: keyof Filters, v: string | boolean) => setDraft({ ...draft, [k]: v });
  return (
    <>
      <h2>Content Explorer</h2>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(null);
          setFilters(draft);
        }}
      >
        <label>
          Project
          <select value={draft.projectId} onChange={(e) => set('projectId', e.target.value)}>
            <option value="">All</option>
            {projects.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Platform
          <select value={draft.platform} onChange={(e) => set('platform', e.target.value)}>
            <option value="">All</option>
            {PLATFORMS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Format
          <select value={draft.contentType} onChange={(e) => set('contentType', e.target.value)}>
            <option value="">All</option>
            {['video', 'short', 'live', 'image', 'text', 'link', 'mixed', 'unknown'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Text
          <input className="narrow" value={draft.q} onChange={(e) => set('q', e.target.value)} placeholder="caption/title" />
        </label>
        <label>
          Hashtag
          <input className="narrow" value={draft.hashtag} onChange={(e) => set('hashtag', e.target.value)} placeholder="#livewallpaper" />
        </label>
        <label>
          Published from
          <input className="narrow" type="date" value={draft.since} onChange={(e) => set('since', e.target.value)} />
        </label>
        <label>
          to
          <input className="narrow" type="date" value={draft.until} onChange={(e) => set('until', e.target.value)} />
        </label>
        <label>
          <span>
            <input type="checkbox" checked={draft.includeUnavailable} onChange={(e) => set('includeUnavailable', e.target.checked)} /> show unavailable
          </span>
        </label>
        <button type="submit" className="primary">Apply</button>
        <button type="button" onClick={() => (setDraft(EMPTY), setFilters(EMPTY), setCursor(null))}>
          Reset
        </button>
      </form>
      <div className="row">
        <ExportButton filters={filters} />
        <Loading on={list.loading} />
      </div>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>Published</th>
            <th>Account</th>
            <th>Content</th>
            <th>Views</th>
            <th>Likes</th>
            <th>Comments</th>
            <th>Shares</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.id}>
              <td className="small">
                {fmtTime(p.publishedAt)}
                {p.status !== 'AVAILABLE' && (
                  <div>
                    <Status s={p.status} /> <span className="muted">{p.unavailable?.reason}</span>
                  </div>
                )}
              </td>
              <td className="small">
                <a href={`#/account/${p.accountId}`}>{p.account.displayName ?? p.account.username}</a>
                <div className="muted">
                  {p.platform} · {p.contentType}
                </div>
              </td>
              <td className="caption">
                <ExternalLink href={p.url}>{p.title ?? (p.caption ? p.caption.slice(0, 200) : '(no text)')}</ExternalLink>
                {p.hashtags.length > 0 && <div className="muted small">#{p.hashtags.join(' #')}</div>}
              </td>
              <td>{fmtNum(p.metrics?.views, p.metrics?.missing?.views)}</td>
              <td>{fmtNum(p.metrics?.likes, p.metrics?.missing?.likes)}</td>
              <td>{fmtNum(p.metrics?.comments, p.metrics?.missing?.comments)}</td>
              <td>{fmtNum(p.metrics?.shares, p.metrics?.missing?.shares)}</td>
              <td className="small muted">
                {p.provenance.providerId}
                <div>{fmtTime(p.metrics?.collectedAt ?? p.provenance.lastCollectedAt)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.loading && pages.length === 0 && !list.error && <Empty>No posts match these filters.</Empty>}
      {list.data?.nextCursor && <button onClick={() => setCursor(list.data!.nextCursor)}>Load more</button>}
    </>
  );
}
