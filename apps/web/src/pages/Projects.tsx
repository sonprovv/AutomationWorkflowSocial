import { useState, type FormEvent } from 'react';
import { api, ApiError, type Candidate, type CoverageEntry, type Job, type Keyword, type Page, type Project } from '../api.ts';
import { ACTIVE, Empty, errText, ErrorBox, ExternalLink, fmtNum, fmtTime, Loading, PLATFORMS, Status, useLoad, usePoll } from '../ui.tsx';

export function Projects() {
  const list = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [name, setName] = useState('');
  const [platforms, setPlatforms] = useState<string[]>(['bluesky']);
  const [languages, setLanguages] = useState('en');
  const [err, setErr] = useState<string | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const langs = languages.split(',').map((s) => s.trim()).filter(Boolean);
      const p = await api<Project>('/projects', { method: 'POST', body: { name, platforms, languages: langs } });
      setName('');
      location.hash = `#/project/${p.id}`;
    } catch (x) {
      setErr(errText(x));
    }
  }
  return (
    <>
      <h2>Projects</h2>
      <form onSubmit={create} className="filters">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Depth Clock Wallpaper" required maxLength={200} />
        </label>
        <label>
          Languages (comma separated)
          <input className="narrow" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="en, vi" />
        </label>
        <label>
          Platforms
          <span className="row" style={{ margin: 0 }}>
            {PLATFORMS.map((p) => (
              <span key={p} className="small">
                <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => setPlatforms(e.target.checked ? [...platforms, p] : platforms.filter((x) => x !== p))} /> {p}
              </span>
            ))}
          </span>
        </label>
        <button type="submit">Create project</button>
      </form>
      <ErrorBox error={err ?? list.error} />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Platforms</th>
            <th>Accounts</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((p) => (
            <tr key={p.id}>
              <td>
                <a href={`#/project/${p.id}`}>{p.name}</a>
              </td>
              <td>
                <Status s={p.status} />
              </td>
              <td className="small">{p.platforms.join(', ') || '—'}</td>
              <td>{p.accountCount ?? '—'}</td>
              <td className="small">{fmtTime(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <Empty>No projects yet.</Empty>}
    </>
  );
}

function Keywords({ projectId }: { projectId: string }) {
  const list = useLoad(() => api<{ items: Keyword[] }>(`/projects/${projectId}/keywords`), [projectId]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ created: Keyword[]; existing: Keyword[] }>(`/projects/${projectId}/keywords`, {
        method: 'POST',
        body: { keywords: text.split(/[\n,]/).map((t) => t.trim()).filter(Boolean).map((t) => ({ text: t })) },
      });
      setMsg(`${r.created.length} added${r.existing.length ? `, ${r.existing.length} already existed` : ''}.`);
      setText('');
      list.reload();
    } catch (x) {
      setMsg(errText(x));
    }
  }
  async function expand() {
    try {
      const r = await api<{ suggested: Keyword[] }>(`/projects/${projectId}/keywords/expand`, { method: 'POST' });
      setMsg(`${r.suggested.length} suggestion(s) — activate the ones you want searched.`);
      list.reload();
    } catch (x) {
      setMsg(errText(x));
    }
  }
  async function setStatus(k: Keyword, status: string) {
    await api(`/keywords/${k.id}`, { method: 'PATCH', body: { status } }).catch(() => {});
    list.reload();
  }
  return (
    <section>
      <h3>Keywords</h3>
      <form onSubmit={add} className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="live wallpaper, depth wallpaper" required />
        <button type="submit">Add</button>
        <button type="button" onClick={expand}>
          Suggest variants (rule-based)
        </button>
      </form>
      {msg && <p className="small">{msg}</p>}
      <ErrorBox error={list.error} />
      <table>
        <tbody>
          {list.data?.items.map((k) => (
            <tr key={k.id}>
              <td>{k.text}</td>
              <td>
                <Status s={k.status} /> <span className="muted small">{k.origin}</span>
              </td>
              <td>
                {k.status !== 'ACTIVE' && <button onClick={() => setStatus(k, 'ACTIVE')}>Activate</button>}{' '}
                {k.status === 'ACTIVE' && <button onClick={() => setStatus(k, 'PAUSED')}>Pause</button>}{' '}
                {k.status === 'SUGGESTED' && <button onClick={() => setStatus(k, 'REJECTED')}>Reject</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <Empty>No keywords — add seed keywords to start discovery.</Empty>}
    </section>
  );
}

function Discovery({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const last = useLoad(() => api<{ items: Job[] }>(`/jobs?projectId=${projectId}&limit=20`).then((r) => r.items.find((j) => j.name === 'project.discover') ?? null), [projectId]);
  const shown = job ?? last.data;
  usePoll(
    async () => {
      if (!job) return;
      const j = await api<Job>(`/jobs/${job.id}`);
      setJob(j);
      if (!ACTIVE.includes(j.status)) onDone();
    },
    !!job && ACTIVE.includes(job.status),
  );
  async function run() {
    setErr(null);
    try {
      const r = await api<{ job: Job }>(`/projects/${projectId}/discover`, { method: 'POST', body: {} });
      setJob(r.job);
    } catch (x) {
      if (x instanceof ApiError && x.code === 'CONFLICT' && typeof x.details?.jobId === 'string') setJob(await api<Job>(`/jobs/${x.details.jobId}`));
      else setErr(errText(x));
    }
  }
  const coverage = (shown?.result?.coverage ?? []) as CoverageEntry[];
  return (
    <section>
      <h3>Discovery</h3>
      <div className="row">
        <button onClick={run} disabled={!!job && ACTIVE.includes(job.status)}>
          Run discovery
        </button>
        {shown && (
          <span>
            Last run <Status s={shown.status} /> {shown.progress}% · {fmtTime(shown.createdAt)}
            {shown.error && <span className="error-inline"> {shown.error.code}: {shown.error.message}</span>}
          </span>
        )}
      </div>
      <ErrorBox error={err} />
      {coverage.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Platform</th>
              <th>Keyword</th>
              <th>Operation</th>
              <th>Status</th>
              <th>Results</th>
              <th>Reason / warnings</th>
            </tr>
          </thead>
          <tbody>
            {coverage.map((c, i) => (
              <tr key={i}>
                <td>{c.platform}</td>
                <td>{c.keyword ?? '—'}</td>
                <td className="small">{c.operation}</td>
                <td>
                  <Status s={c.status} />
                </td>
                <td>{c.results === null ? <span className="muted">n/a</span> : c.results}</td>
                <td className="small">{[c.reason, ...c.warnings].filter(Boolean).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Candidates({ projectId, version }: { projectId: string; version: number }) {
  const [status, setStatus] = useState('PENDING');
  const [minScore, setMinScore] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useLoad(
    () => api<Page<Candidate>>(`/projects/${projectId}/candidates?status=${status}&limit=50${minScore ? `&minScore=${minScore}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    [projectId, status, minScore, cursor, version],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  async function decide(action: 'approve' | 'reject') {
    try {
      const r = await api<{ approved: unknown[]; rejected: string[]; warnings: string[] }>(`/projects/${projectId}/candidates/${action}`, { method: 'POST', body: { candidateIds: selected } });
      setMsg(`${action === 'approve' ? `${r.approved.length} approved and syncing` : `${r.rejected.length} rejected`}. ${r.warnings.join(' ')}`);
      setSelected([]);
      list.reload();
    } catch (x) {
      setMsg(errText(x));
    }
  }
  return (
    <section>
      <h3>Review queue</h3>
      <div className="row">
        <select value={status} onChange={(e) => (setStatus(e.target.value), setCursor(null))}>
          {['PENDING', 'APPROVED', 'REJECTED'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <input className="narrow" type="number" min={0} max={100} value={minScore} onChange={(e) => (setMinScore(e.target.value), setCursor(null))} placeholder="min score" />
        <button disabled={!selected.length} onClick={() => decide('approve')}>
          Approve &amp; track ({selected.length})
        </button>
        <button disabled={!selected.length} onClick={() => decide('reject')}>
          Reject ({selected.length})
        </button>
        <Loading on={list.loading} />
      </div>
      {msg && <p className="small">{msg}</p>}
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th />
            <th>Account</th>
            <th>Score</th>
            <th>Type (rule guess)</th>
            <th>Followers</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((c) => (
            <tr key={c.id}>
              <td>
                <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
              </td>
              <td>
                <ExternalLink href={c.account.profileUrl}>{c.account.displayName ?? c.account.username}</ExternalLink>
                <div className="muted small">
                  {c.account.platform} · @{c.account.username} {c.decidedBy && `· decided by ${c.decidedBy}`}
                </div>
              </td>
              <td>
                <b>{Math.round(c.score)}</b>
              </td>
              <td className="small">
                {c.classification}
                <div className="muted">confidence {c.evidence.confidence ?? '—'}</div>
              </td>
              <td>{fmtNum(c.evidence.profile?.followers ?? null)}</td>
              <td className="small">
                <details>
                  <summary>{(c.evidence.reasons ?? []).length} reason(s)</summary>
                  <ul className="evidence">
                    {(c.evidence.reasons ?? []).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  {c.account.bio && <p className="muted">{c.account.bio.slice(0, 300)}</p>}
                  <ul className="evidence">
                    {(c.evidence.samplePosts ?? []).map((p) => (
                      <li key={p.url}>
                        <ExternalLink href={p.url}>{p.text ?? p.url}</ExternalLink> <span className="muted">({p.keyword})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <Empty>No {status.toLowerCase()} candidates. Run discovery with active keywords.</Empty>}
      {list.data?.nextCursor && <button onClick={() => setCursor(list.data!.nextCursor)}>Next page</button>}
      {cursor && <button onClick={() => setCursor(null)}>First page</button>}
    </section>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const p = useLoad(() => api<Project>(`/projects/${id}`), [id]);
  const [version, setVersion] = useState(0);
  async function patch(body: object) {
    await api(`/projects/${id}`, { method: 'PATCH', body }).catch(() => {});
    p.reload();
  }
  const s = (p.data?.settings ?? {}) as Record<string, number | boolean | string>;
  return (
    <>
      <p>
        <a href="#/projects">← Projects</a>
      </p>
      <ErrorBox error={p.error} />
      {p.data && (
        <>
          <h2>
            {p.data.name} <Status s={p.data.status} />
          </h2>
          <p className="muted small">
            Platforms {p.data.platforms.join(', ') || '—'} · languages {p.data.languages.join(', ') || '—'} · timezone {p.data.timezone} ·{' '}
            <a href={`#/explore?projectId=${id}`}>Content of this project →</a>
          </p>
          <div className="row small">
            <span>Sync every {String(s.sync_interval_minutes)} min</span>·<span>Scheduled discovery: {s.discovery_every_hours ? `every ${String(s.discovery_every_hours)} h` : 'off'}</span>·
            <span>Auto-track: {s.auto_track ? `on (score ≥ ${String(s.auto_track_min_score)}, ≤ ${String(s.auto_track_max_per_run)}/run)` : 'off'}</span>
            <button onClick={() => patch({ status: p.data!.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>{p.data.status === 'ACTIVE' ? 'Pause project' : 'Resume project'}</button>
            <button onClick={() => patch({ settings: { discovery_every_hours: s.discovery_every_hours ? 0 : 24 } })}>{s.discovery_every_hours ? 'Turn off daily discovery' : 'Run discovery daily'}</button>
          </div>
          <div className="grid2">
            <Keywords projectId={id} />
            <Discovery projectId={id} onDone={() => setVersion((v) => v + 1)} />
          </div>
          <Candidates projectId={id} version={version} />
        </>
      )}
    </>
  );
}
