import { useState } from 'react';
import { api, type Job, type Page, type Project } from '../api.ts';
import { defineMessages, useT } from '../i18n.tsx';
import { ACTIVE, Empty, errText, ErrorBox, ExternalLink, fmtTime, Loading, Status, useLoad, usePoll } from '../ui.tsx';

const M = defineMessages({
  title: ['Insights', 'Phân tích'],
  policyNotice: [
    'Derived analytics run only for data sources whose policy allows them (Data Sources → policy). Data from other sources is counted as “blocked by policy”, never scored as 0.',
    'Phân tích dẫn xuất chỉ chạy cho các nguồn dữ liệu có chính sách cho phép (Nguồn dữ liệu → chính sách). Dữ liệu từ các nguồn khác được tính là “bị chính sách chặn”, không bao giờ bị chấm điểm 0.',
  ],
  createProject: ['Create a project first.', 'Hãy tạo dự án trước.'],
  viralFeed: ['Viral feed', 'Bảng tin lan truyền (viral)'],
  scoreNow: ['Score now', 'Chấm điểm ngay'],
  thresholds: ['Thresholds: {list} (experimental).', 'Ngưỡng: {list} (thử nghiệm).'],
  thPost: ['Post', 'Bài đăng'],
  thScore: ['Score', 'Điểm'],
  thLabel: ['Label', 'Nhãn'],
  thFeaturesUsed: ['Features used', 'Đặc trưng đã dùng'],
  thMissing: ['Missing', 'Còn thiếu'],
  thScored: ['Scored', 'Chấm điểm lúc'],
  noScores: ['No scores yet (or every source is blocked by policy). Click “Score now”.', 'Chưa có điểm nào (hoặc mọi nguồn đều bị chính sách chặn). Bấm “Chấm điểm ngay”.'],
  trends: ['Trends', 'Xu hướng'],
  compute7: ['Compute (7 days)', 'Tính toán (7 ngày)'],
  sample: ['Sample: {n} post(s) in the last {days} d · computed {at}', 'Mẫu: {n} bài đăng trong {days} ngày gần nhất · tính lúc {at}'],
  blockedByPolicy: [' · blocked by policy: {list}', ' · bị chính sách chặn: {list}'],
  thTopic: ['Topic', 'Chủ đề'],
  thSignal: ['Signal', 'Tín hiệu'],
  thPostsNowBefore: ['Posts (now / before)', 'Bài đăng (hiện tại / trước đó)'],
  thAccounts: ['Accounts', 'Tài khoản'],
  thConfidence: ['Confidence', 'Độ tin cậy'],
  thWhy: ['Why / supporting posts', 'Lý do / bài đăng minh chứng'],
  post: ['post', 'bài đăng'],
  noTopic: ['No topic with at least 2 posts in this window.', 'Không có chủ đề nào có ít nhất 2 bài đăng trong khoảng thời gian này.'],
  aiIntelligence: ['AI intelligence', 'Phân tích AI'],
  analyseTop: ['Analyse top posts', 'Phân tích các bài đăng nổi bật'],
  aiOff: ['{key} is not configured — AI analysis is off.', 'Chưa cấu hình {key} — Phân tích AI đang tắt.'],
  model: ['model {model}', 'mô hình {model}'],
  confidence: ['confidence {c}', 'độ tin cậy {c}'],
  hook: ['Hook:', 'Câu mở đầu (hook):'],
  message: ['Message:', 'Thông điệp:'],
  cta: ['CTA:', 'CTA:'],
  evidence: ['Evidence:', 'Bằng chứng:'],
  audienceHypotheses: ['Audience hypotheses', 'Giả thuyết về khán giả'],
  notDemographics: ['(not demographics):', '(không phải nhân khẩu học):'],
  ideasForUs: ['Ideas for us:', 'Ý tưởng cho chúng ta:'],
  inspiredBy: ['— inspired by {x}', '— lấy cảm hứng từ {x}'],
  limitations: ['Limitations: {list}', 'Hạn chế: {list}'],
  noAi: ['No AI analyses yet.', 'Chưa có phân tích AI nào.'],
});

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
  const t = useT(M);
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
        <h2 style={{ margin: 0 }}>{t('title')}</h2>
        <select value={pid} onChange={(e) => setProjectId(e.target.value)}>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="notice">{t('policyNotice')}</div>
      {!pid && <Empty>{t('createProject')}</Empty>}
      {pid && (
        <>
          <section>
            <div className="row">
              <h3 style={{ margin: 0 }}>{t('viralFeed')}</h3>
              <RunButton label={t('scoreNow')} url={`/projects/${pid}/analytics/viral`} onDone={viral.reload} />
              <Loading on={viral.loading} />
            </div>
            <p className="muted small">{viral.data?.note} {t('thresholds', { list: viral.data ? Object.entries(viral.data.thresholds).map(([k, v]) => `${k} ≥ ${v}`).join(', ') : '' })}</p>
            <ErrorBox error={viral.error} />
            <table>
              <thead>
                <tr>
                  <th>{t('thPost')}</th>
                  <th>{t('thScore')}</th>
                  <th>{t('thLabel')}</th>
                  <th>{t('thFeaturesUsed')}</th>
                  <th>{t('thMissing')}</th>
                  <th>{t('thScored')}</th>
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
            {viral.data?.items.length === 0 && <Empty>{t('noScores')}</Empty>}
          </section>

          <section>
            <div className="row">
              <h3 style={{ margin: 0 }}>{t('trends')}</h3>
              <RunButton label={t('compute7')} url={`/projects/${pid}/analytics/trends`} body={{ windowDays: 7 }} onDone={trends.reload} />
            </div>
            <ErrorBox error={trends.error} />
            {trends.data?.coverage && (
              <p className="muted small">
                {trends.data.coverage.scope} {t('sample', { n: trends.data.sampleSize ?? '', days: trends.data.windowDays ?? '', at: fmtTime(trends.data.computedAt) })}
                {trends.data.coverage.blockedByPolicy.length > 0 && t('blockedByPolicy', { list: trends.data.coverage.blockedByPolicy.map((b) => `${b.providerId} ${b.posts}`).join(', ') })}
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>{t('thTopic')}</th>
                  <th>{t('thSignal')}</th>
                  <th>{t('thPostsNowBefore')}</th>
                  <th>{t('thAccounts')}</th>
                  <th>{t('thConfidence')}</th>
                  <th>{t('thWhy')}</th>
                </tr>
              </thead>
              <tbody>
                {trends.data?.topics.map((tp) => (
                  <tr key={tp.topic}>
                    <td>
                      {tp.topic} <span className="muted small">{tp.kind}</span>
                    </td>
                    <td>
                      <Status s={tp.signal} />
                    </td>
                    <td>
                      {tp.postsNow} / {tp.postsPrev}
                    </td>
                    <td>{tp.accountsNow}</td>
                    <td>{tp.confidence}</td>
                    <td className="small">
                      {tp.reasons.join(' · ')}
                      <div>
                        {tp.supportingPosts.slice(0, 3).map((p, i) => (
                          <span key={p.url}>
                            {i > 0 && ' · '}
                            <ExternalLink href={p.url}>{p.account ?? t('post')}</ExternalLink>
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(trends.data?.topics.length ?? 0) === 0 && <Empty>{trends.data?.note ?? t('noTopic')}</Empty>}
          </section>

          <section>
            <div className="row">
              <h3 style={{ margin: 0 }}>{t('aiIntelligence')}</h3>
              {ai.data?.configured ? <RunButton label={t('analyseTop')} url={`/projects/${pid}/analyze`} onDone={ai.reload} /> : <span className="notice">{t('aiOff', { key: 'ANTHROPIC_API_KEY' })}</span>}
              <span className="muted small">{t('model', { model: ai.data?.model ?? '' })}</span>
            </div>
            <ErrorBox error={ai.error} />
            {ai.data?.items.map((a) => (
              <details key={a.id} className="tile" style={{ marginBottom: 8 }}>
                <summary>
                  <Status s={a.status} /> {a.url ? <ExternalLink href={a.url}>{a.account ?? t('post')}</ExternalLink> : '—'} · {a.result?.category ?? a.error} · {t('confidence', { c: a.confidence ?? '—' })} · {a.scope} · ${a.costUsd.toFixed(4)} · {fmtTime(a.createdAt)}
                </summary>
                {a.result && (
                  <div className="small">
                    <p>
                      <b>{t('hook')}</b> {a.result.hook ?? '—'} · <b>{t('message')}</b> {a.result.keyMessage} · <b>{t('cta')}</b> {a.result.cta ?? '—'}
                    </p>
                    <p>
                      <b>{t('evidence')}</b>
                    </p>
                    <ul className="evidence">
                      {a.result.evidence?.map((e, i) => (
                        <li key={i}>
                          {e.claim} — <span className="muted">{e.field}: “{e.quote}”</span>
                        </li>
                      ))}
                    </ul>
                    <p>
                      <b>{t('audienceHypotheses')}</b> {t('notDemographics')}
                    </p>
                    <ul className="evidence">
                      {a.result.audienceHypotheses?.map((x, i) => (
                        <li key={i}>
                          {x.hypothesis} <span className="muted">— {x.basis}</span>
                        </li>
                      ))}
                    </ul>
                    <p>
                      <b>{t('ideasForUs')}</b>
                    </p>
                    <ul className="evidence">
                      {a.result.creativeIdeas?.map((x, i) => (
                        <li key={i}>
                          {x.idea} <span className="muted">{t('inspiredBy', { x: x.inspiredBy })}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="muted">{t('limitations', { list: a.result.limitations?.join(' · ') ?? '' })}</p>
                  </div>
                )}
              </details>
            ))}
            {ai.data?.items.length === 0 && <Empty>{t('noAi')}</Empty>}
          </section>
        </>
      )}
    </>
  );
}
