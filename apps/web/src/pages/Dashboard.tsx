import { useState } from 'react';
import { api, type Dashboard as D, type Page, type PostFull, type Project } from '../api.ts';
import { ErrorBox, ExternalLink, fmtNum, fmtTime, Loading, Status, useLoad } from '../ui.tsx';

export function PostLine({ p }: { p: PostFull }) {
  return (
    <tr>
      <td className="small">{fmtTime(p.publishedAt)}</td>
      <td className="small">
        {p.platform} · @{p.account.username ?? '—'}
      </td>
      <td className="caption">
        <ExternalLink href={p.url}>{p.title ?? (p.caption ? p.caption.slice(0, 120) : '(no text)')}</ExternalLink>
      </td>
      <td>{fmtNum(p.metrics?.likes, p.metrics?.missing?.likes)}</td>
      <td className="small muted">{fmtTime(p.metrics?.collectedAt ?? p.provenance.lastCollectedAt)}</td>
    </tr>
  );
}

export function Dashboard() {
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [projectId, setProjectId] = useState('');
  const d = useLoad(() => api<D>(`/dashboard${projectId ? `?projectId=${projectId}` : ''}`), [projectId]);
  const max = Math.max(1, ...(d.data?.postsPerDay.map((x) => x.posts) ?? [1]));
  const c = d.data?.counts;
  const tiles: [string, number | undefined][] = [
    ['Active projects', c?.projects],
    ['Tracked accounts', c?.trackedAccounts],
    ['Posts stored', c?.posts],
    ['Collected in 24 h', c?.newPosts24h],
    ['Collected in 7 d', c?.newPosts7d],
    ['Candidates to review', c?.pendingCandidates],
    ['Active keywords', c?.activeKeywords],
    ['Unavailable posts', c?.unavailablePosts],
  ];
  return (
    <>
      <div className="row">
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Loading on={d.loading} />
      </div>
      <ErrorBox error={d.error} />
      {d.data && (
        <>
          <div className="tiles">
            {tiles.map(([label, v]) => (
              <div className="tile" key={label}>
                <b>{fmtNum(v)}</b>
                <span className="muted small">{label}</span>
              </div>
            ))}
          </div>
          <div className="grid2">
            <section>
              <h3>Posts per day (14 days, by publish time)</h3>
              <div className="bars" hidden={d.data.postsPerDay.length === 0}>
                {d.data.postsPerDay.map((x) => (
                  <div key={x.day} style={{ height: `${(x.posts / max) * 100}%` }} title={`${x.day}: ${x.posts}`} />
                ))}
              </div>
              <div className="bars-labels">
                {d.data.postsPerDay.map((x) => (
                  <span key={x.day}>{x.day.slice(5)}</span>
                ))}
              </div>
              {d.data.postsPerDay.length === 0 && <p className="muted">No posts in the last 14 days.</p>}
              <h3>Jobs (24 h)</h3>
              <p>
                {Object.entries(d.data.jobs.byStatus).map(([s, n]) => (
                  <span key={s} style={{ marginRight: 12 }}>
                    <Status s={s} /> {n}
                  </span>
                ))}
                {Object.keys(d.data.jobs.byStatus).length === 0 && <span className="muted">No jobs.</span>}
              </p>
              {d.data.jobs.stuck > 0 && <div className="notice">{d.data.jobs.stuck} job(s) look stuck — see the Job Monitor.</div>}
              <h3>Scheduler {d.data.scheduler.paused && <Status s="PAUSED" />}</h3>
              {d.data.scheduler.next.length === 0 && <p className="muted">No schedules yet — they are created on the first scheduler tick.</p>}
              <table>
                <tbody>
                  {d.data.scheduler.next.map((s) => (
                    <tr key={s.id}>
                      <td>{s.workflowKey}</td>
                      <td className="small">next {fmtTime(s.nextRunAt)}</td>
                      <td>
                        <Status s={s.lastStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section>
              <h3>Latest posts</h3>
              <table>
                <tbody>
                  {d.data.latestPosts.map((p) => (
                    <PostLine key={p.id} p={p} />
                  ))}
                </tbody>
              </table>
              {d.data.latestPosts.length === 0 && <p className="muted">No posts yet — track an account or run discovery.</p>}
              <h3>Most liked (7 days)</h3>
              <p className="muted small">{d.data.topPostsByLikes7d.note}</p>
              {d.data.topPostsByLikes7d.items.length === 0 && <p className="muted">No posts published in the last 7 days have a like count.</p>}
              <table>
                <tbody>
                  {d.data.topPostsByLikes7d.items.map((p) => (
                    <PostLine key={p.id} p={p} />
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <h3>Coverage &amp; usage today</h3>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Phase 0 status</th>
                <th>Enabled</th>
                <th>Health</th>
                <th>Used today</th>
                <th>Reserved now</th>
                <th>Cost today</th>
              </tr>
            </thead>
            <tbody>
              {d.data.coverage.map((p) => (
                <tr key={p.providerId}>
                  <td>
                    {p.providerId} <span className="muted small">{p.platform}</span>
                  </td>
                  <td>
                    <Status s={p.status} />
                  </td>
                  <td>{p.enabled ? 'yes' : <span className="muted">no</span>}</td>
                  <td className="small">
                    {p.healthy === null ? '—' : p.healthy ? 'healthy' : 'unhealthy'} {p.checkedAt && `(${fmtTime(p.checkedAt)})`}
                  </td>
                  <td className="small">{Object.entries(p.usageToday).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</td>
                  <td className="small">{Object.entries(p.reservedToday).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</td>
                  <td>${p.costTodayUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
