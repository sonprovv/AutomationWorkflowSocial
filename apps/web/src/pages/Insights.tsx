import { useState } from 'react';
import { api, type Job, type Page, type Project } from '../api.ts';
import { ACTIVE, Empty, errText, ErrorBox, ExternalLink, fmtTime, Loading, Status, useLoad, usePoll } from '../ui.tsx';

/*
 * Phase 6 screens (Master Plan §10 Viral Feed, Trends, AI Intelligence). Everything here is derived analytics:
 * shown only for providers whose policy allows it; every score shows its version, available/missing features
 * and the explanation; trends are labelled "collected sample only"; AI output shows scope, confidence,
 * evidence and limitations.
 */

type ViralItem = { postId: string; url: string | null; account: string | null; platform: string | null; publishedAt: string | null; status: string; score: number | null; label: string | null; features: { available?: string[]; missing?: string[]; normalized?: Record<string, number | null>; flags?: string[]; cohort?: { key: string; comparedWith: string } }; scoredAt: string };
type Topic = { topic: string; kind: string; signal: string; postsNow: number; postsPrev: number; accountsNow: number; growth: number | null; confidence: string; reasons: string[]; supportingPosts: { url: string; account: string | null }[] };
type AiItem = { id: string; url: string | null; account: string | null; status: string; scope: string; confidence: number | null; error: string | null; createdAt: string; costUsd: number; result: { category?: string; hook?: string | null; keyMessage?: string; cta?: string | null; evidence?: { claim: string; field: string; quote: string }[]; limitations?: string[]; creativeIdeas?: { idea: string; inspiredBy: string }[]; audienceHypotheses?: { hypothesis: string; basis: string }[] } | null };

function RunButton({ label, url, body, onDone }: { label: string; url: string; body?: object; onDone: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  usePoll(
    async () => {
      if (!job) return;
      const j = await api<Job>(`/jobs/${job.id}`);
      setJob(j);
      if (!ACTIVE.includes(j.status)) onDone();
    },
    !!job && ACTIVE.includes(job.status),
  );
  return (
    <span className="row" style={{ margin: 0 }}>
      <button
        disabled={!!job && ACTIVE.includes(job.status)}
        onClick={async () => {
          setErr(null);
          try {
            setJob((await api<{ job: Job }>(url, { method: 'POST', body: body ?? {} })).job);
          } catch (x) {
            setErr(errText(x));
          }
        }}
      >
        {label}
      </button>
      {job && (
        <span className="small">
          <Status s={job.status} /> {job.warnings.slice(0, 2).join(' · ')} {job.error && <span className="error-inline">{job.error.code}: {job.error.message}</span>}
        </span>
      )}
      {err && <span className="error-inline small">{err}</span>}
    </span>
  );
}

export function Insights() {
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const initial = new URLSearchParams(location.hash.split('?')[1] ?? '').get('projectId') ?? '';
  const [projectId, setProjectId] = useState(initial);
  const pid = projectId || projects.data?.items[0]?.id || '';
  const viral = useLoad(() => (pid ? api<{ items: ViralItem[]; note: string; thresholds: Record<string, number> }>(`/analytics/viral?projectId=${pid}`) : Promise.resolve(null)), [pid]);
  const trends = useLoad(() => (pid ? api<{ topics: Topic[]; computedAt?: string; sampleSize?: number; windowDays?: number; coverage?: { scope: string; blockedByPolicy: { providerId: string; posts: number }[] }; note?: string }>(`/analytics/trends?projectId=${pid}`) : Promise.resolve(null)), [pid]);
  const ai = useLoad(() => (pid ? api<{ configured: boolean; model: string; items: AiItem[] }>(`/analytics/ai?projectId=${pid}`) : Promise.resolve(null)), [pid]);
  return (
    <>
      <div className="row">
        <h2 style={{ margin: 0 }}>Insights</h2>
        <select value={pid} onChange={(e) => setProjectId(e.target.value)}>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="notice">Derived analytics run only for data sources whose policy allows them (Data Sources → policy). Data from other sources is counted as “blocked by policy”, never scored as 0.</div>
      {!pid && <Empty>Create a project first.</Empty>}
      {pid && (
        <>
          <section>
            <div className="row">
              <h3 style={{ margin: 0 }}>Viral feed</h3>
              <RunButton label="Score now" url={`/projects/${pid}/analytics/viral`} onDone={viral.reload} />
              <Loading on={viral.loading} />
            </div>
            <p className="muted small">{viral.data?.note} Thresholds: {viral.data && Object.entries(viral.data.thresholds).map(([k, v]) => `${k} ≥ ${v}`).join(', ')} (experimental).</p>
            <ErrorBox error={viral.error} />
            <table>
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Score</th>
                  <th>Label</th>
                  <th>Features used</th>
                  <th>Missing</th>
                  <th>Scored</th>
                </tr>
              </thead>
              <tbody>
                {viral.data?.items.map((v) => (
                  <tr key={v.postId}>
                    <td className="small">
                      {v.url ? <ExternalLink href={v.url}>{v.account ?? v.url}</ExternalLink> : '—'} <span className="muted">{v.platform}</span>
                    </td>
                    <td>{v.score === null ? <Status s={v.status} /> : <b>{v.score}</b>}</td>
                    <td>{v.label ?? '—'}</td>
                    <td className="small">
                      {(v.features.available ?? []).map((k) => `${k} ${v.features.normalized?.[k] ?? ''}`).join(' · ')}
                      {v.features.flags?.length ? <div className="error-inline">{v.features.flags.join(', ')}</div> : null}
                    </td>
                    <td className="small muted">{(v.features.missing ?? []).join(', ') || '—'}</td>
                    <td className="small">{fmtTime(v.scoredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {viral.data?.items.length === 0 && <Empty>No scores yet (or every source is blocked by policy). Click “Score now”.</Empty>}
          </section>

          <section>
            <div className="row">
              <h3 style={{ margin: 0 }}>Trends</h3>
              <RunButton label="Compute (7 days)" url={`/projects/${pid}/analytics/trends`} body={{ windowDays: 7 }} onDone={trends.reload} />
            </div>
            <ErrorBox error={trends.error} />
            {trends.data?.coverage && (
              <p className="muted small">
                {trends.data.coverage.scope} Sample: {trends.data.sampleSize} post(s) in the last {trends.data.windowDays} d · computed {fmtTime(trends.data.computedAt)}
                {trends.data.coverage.blockedByPolicy.length > 0 && ` · blocked by policy: ${trends.data.coverage.blockedByPolicy.map((b) => `${b.providerId} ${b.posts}`).join(', ')}`}
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Signal</th>
                  <th>Posts (now / before)</th>
                  <th>Accounts</th>
                  <th>Confidence</th>
                  <th>Why / supporting posts</th>
                </tr>
              </thead>
              <tbody>
                {trends.data?.topics.map((t) => (
                  <tr key={t.topic}>
                    <td>
                      {t.topic} <span className="muted small">{t.kind}</span>
                    </td>
                    <td>
                      <Status s={t.signal} />
                    </td>
                    <td>
                      {t.postsNow} / {t.postsPrev}
                    </td>
                    <td>{t.accountsNow}</td>
                    <td>{t.confidence}</td>
                    <td className="small">
                      {t.reasons.join(' · ')}
                      <div>
                        {t.supportingPosts.slice(0, 3).map((p, i) => (
                          <span key={p.url}>
                            {i > 0 && ' · '}
                            <ExternalLink href={p.url}>{p.account ?? 'post'}</ExternalLink>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(trends.data?.topics.length ?? 0) === 0 && <Empty>{trends.data?.note ?? 'No topic with at least 2 posts in this window.'}</Empty>}
          </section>

          <section>
            <div className="row">
              <h3 style={{ margin: 0 }}>AI intelligence</h3>
              {ai.data?.configured ? <RunButton label="Analyse top posts" url={`/projects/${pid}/analyze`} onDone={ai.reload} /> : <span className="notice">ANTHROPIC_API_KEY is not configured — AI analysis is off.</span>}
              <span className="muted small">model {ai.data?.model}</span>
            </div>
            <ErrorBox error={ai.error} />
            {ai.data?.items.map((a) => (
              <details key={a.id} className="tile" style={{ marginBottom: 8 }}>
                <summary>
                  <Status s={a.status} /> {a.url ? <ExternalLink href={a.url}>{a.account ?? 'post'}</ExternalLink> : '—'} · {a.result?.category ?? a.error} · confidence {a.confidence ?? '—'} · {a.scope} · ${a.costUsd.toFixed(4)} · {fmtTime(a.createdAt)}
                </summary>
                {a.result && (
                  <div className="small">
                    <p>
                      <b>Hook:</b> {a.result.hook ?? '—'} · <b>Message:</b> {a.result.keyMessage} · <b>CTA:</b> {a.result.cta ?? '—'}
                    </p>
                    <p>
                      <b>Evidence:</b>
                    </p>
                    <ul className="evidence">
                      {a.result.evidence?.map((e, i) => (
                        <li key={i}>
                          {e.claim} — <span className="muted">{e.field}: “{e.quote}”</span>
                        </li>
                      ))}
                    </ul>
                    <p>
                      <b>Audience hypotheses</b> (not demographics):
                    </p>
                    <ul className="evidence">
                      {a.result.audienceHypotheses?.map((x, i) => (
                        <li key={i}>
                          {x.hypothesis} <span className="muted">— {x.basis}</span>
                        </li>
                      ))}
                    </ul>
                    <p>
                      <b>Ideas for us:</b>
                    </p>
                    <ul className="evidence">
                      {a.result.creativeIdeas?.map((x, i) => (
                        <li key={i}>
                          {x.idea} <span className="muted">— inspired by {x.inspiredBy}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="muted">Limitations: {a.result.limitations?.join(' · ')}</p>
                  </div>
                )}
              </details>
            ))}
            {ai.data?.items.length === 0 && <Empty>No AI analyses yet.</Empty>}
          </section>
        </>
      )}
    </>
  );
}
