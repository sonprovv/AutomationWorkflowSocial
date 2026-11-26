import { useState, type FormEvent } from 'react';
import { api, ApiError, type Candidate, type CoverageEntry, type Job, type Keyword, type Page, type Project } from '../api.ts';
import { defineMessages, useT } from '../i18n.tsx';
import { ACTIVE, Empty, errText, ErrorBox, ExternalLink, fmtNum, fmtTime, Loading, PLATFORMS, Status, useLoad, usePoll } from '../ui.tsx';

const M = defineMessages({
  // shared table headers
  thName: ['Name', 'Tên'],
  thStatus: ['Status', 'Trạng thái'],
  thPlatform: ['Platform', 'Nền tảng'],
  thPlatforms: ['Platforms', 'Nền tảng'],
  thAccount: ['Account', 'Tài khoản'],
  thAccounts: ['Accounts', 'Tài khoản'],
  thCreated: ['Created', 'Ngày tạo'],
  // project list
  projects: ['Projects', 'Dự án'],
  namePlaceholder: ['e.g. Depth Clock Wallpaper', 'VD: Depth Clock Wallpaper'],
  languagesLabel: ['Languages (comma separated)', 'Ngôn ngữ (phân tách bằng dấu phẩy)'],
  createProject: ['Create project', 'Tạo dự án'],
  noProjects: ['No projects yet.', 'Chưa có dự án nào.'],
  // keywords
  keywords: ['Keywords', 'Từ khóa'],
  add: ['Add', 'Thêm'],
  suggestVariants: ['Suggest variants (rule-based)', 'Gợi ý biến thể (theo quy tắc)'],
  kwAdded: ['{n} added', 'Đã thêm {n}'],
  kwExisting: [', {n} already existed', ', {n} đã có sẵn'],
  kwSuggested: ['{n} suggestion(s) — activate the ones you want searched.', 'Có {n} gợi ý — hãy kích hoạt những từ khóa bạn muốn tìm kiếm.'],
  activate: ['Activate', 'Kích hoạt'],
  pause: ['Pause', 'Tạm dừng'],
  reject: ['Reject', 'Từ chối'],
  noKeywords: ['No keywords — add seed keywords to start discovery.', 'Chưa có từ khóa — hãy thêm từ khóa gốc để bắt đầu khám phá.'],
  // discovery
  discovery: ['Discovery', 'Khám phá'],
  runDiscovery: ['Run discovery', 'Chạy khám phá'],
  lastRun: ['Last run', 'Lần chạy gần nhất'],
  thKeyword: ['Keyword', 'Từ khóa'],
  thOperation: ['Operation', 'Thao tác'],
  thResults: ['Results', 'Kết quả'],
  thReason: ['Reason / warnings', 'Lý do / cảnh báo'],
  na: ['n/a', 'không có'],
  // candidates
  reviewQueue: ['Review queue', 'Hàng chờ duyệt'],
  optPending: ['PENDING', 'Chờ duyệt'],
  optApproved: ['APPROVED', 'Đã duyệt'],
  optRejected: ['REJECTED', 'Đã từ chối'],
  minScore: ['min score', 'điểm tối thiểu'],
  approveTrack: ['Approve & track ({n})', 'Duyệt và theo dõi ({n})'],
  rejectN: ['Reject ({n})', 'Từ chối ({n})'],
  approvedMsg: ['{n} approved and syncing', 'Đã duyệt {n}, đang đồng bộ'],
  rejectedMsg: ['{n} rejected', 'Đã từ chối {n}'],
  thScore: ['Score', 'Điểm'],
  thType: ['Type (rule guess)', 'Loại (đoán theo quy tắc)'],
  thFollowers: ['Followers', 'Người theo dõi'],
  thEvidence: ['Evidence', 'Bằng chứng'],
  decidedBy: ['· decided by {who}', '· quyết định bởi {who}'],
  confidence: ['confidence {v}', 'độ tin cậy {v}'],
  reasons: ['{n} reason(s)', '{n} lý do'],
  noPending: ['No pending candidates. Run discovery with active keywords.', 'Không có ứng viên chờ duyệt. Hãy chạy khám phá với các từ khóa đang hoạt động.'],
  noApproved: ['No approved candidates. Run discovery with active keywords.', 'Không có ứng viên đã duyệt. Hãy chạy khám phá với các từ khóa đang hoạt động.'],
  noRejected: ['No rejected candidates. Run discovery with active keywords.', 'Không có ứng viên đã từ chối. Hãy chạy khám phá với các từ khóa đang hoạt động.'],
  nextPage: ['Next page', 'Trang sau'],
  firstPage: ['First page', 'Trang đầu'],
  // project page
  backToProjects: ['← Projects', '← Dự án'],
  projectMeta: ['Platforms {platforms} · languages {languages} · timezone {tz} ·', 'Nền tảng {platforms} · ngôn ngữ {languages} · múi giờ {tz} ·'],
  projectContent: ['Content of this project →', 'Nội dung của dự án này →'],
  syncEvery: ['Sync every {n} min', 'Đồng bộ mỗi {n} phút'],
  scheduledDiscovery: ['Scheduled discovery: {v}', 'Khám phá theo lịch: {v}'],
  everyHours: ['every {n} h', 'mỗi {n} giờ'],
  off: ['off', 'tắt'],
  autoTrack: ['Auto-track: {v}', 'Tự động theo dõi: {v}'],
  autoTrackOn: ['on (score ≥ {min}, ≤ {max}/run)', 'bật (điểm ≥ {min}, ≤ {max}/lần chạy)'],
  pauseProject: ['Pause project', 'Tạm dừng dự án'],
  resumeProject: ['Resume project', 'Tiếp tục dự án'],
  dailyOff: ['Turn off daily discovery', 'Tắt khám phá hằng ngày'],
  dailyOn: ['Run discovery daily', 'Chạy khám phá hằng ngày'],
});

const CANDIDATE_STATUSES = {
  PENDING: { opt: 'optPending', empty: 'noPending' },
  APPROVED: { opt: 'optApproved', empty: 'noApproved' },
  REJECTED: { opt: 'optRejected', empty: 'noRejected' },
} as const;
type CandidateStatus = keyof typeof CANDIDATE_STATUSES;

export function Projects() {
  const t = useT(M);
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
      <h2>{t('projects')}</h2>
      <form onSubmit={create} className="filters">
        <label>
          {t('thName')}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} required maxLength={200} />
        </label>
        <label>
          {t('languagesLabel')}
          <input className="narrow" value={languages} onChange={(e) => setLanguages(e.target.value)} placeholder="en, vi" />
        </label>
        <label>
          {t('thPlatforms')}
          <span className="row" style={{ margin: 0 }}>
            {PLATFORMS.map((p) => (
              <span key={p} className="small">
                <input type="checkbox" checked={platforms.includes(p)} onChange={(e) => setPlatforms(e.target.checked ? [...platforms, p] : platforms.filter((x) => x !== p))} /> {p}
              </span>
            ))}
          </span>
        </label>
        <button type="submit" className="primary">
          {t('createProject')}
        </button>
      </form>
      <ErrorBox error={err ?? list.error} />
      <table>
        <thead>
          <tr>
            <th>{t('thName')}</th>
            <th>{t('thStatus')}</th>
            <th>{t('thPlatforms')}</th>
            <th>{t('thAccounts')}</th>
            <th>{t('thCreated')}</th>
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
      {list.data?.items.length === 0 && <Empty>{t('noProjects')}</Empty>}
    </>
  );
}

function Keywords({ projectId }: { projectId: string }) {
  const t = useT(M);
  const list = useLoad(() => api<{ items: Keyword[] }>(`/projects/${projectId}/keywords`), [projectId]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ created: Keyword[]; existing: Keyword[] }>(`/projects/${projectId}/keywords`, {
        method: 'POST',
        body: { keywords: text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((s) => ({ text: s })) },
      });
      setMsg(`${t('kwAdded', { n: r.created.length })}${r.existing.length ? t('kwExisting', { n: r.existing.length }) : ''}.`);
      setText('');
      list.reload();
    } catch (x) {
      setMsg(errText(x));
    }
  }
  async function expand() {
    try {
      const r = await api<{ suggested: Keyword[] }>(`/projects/${projectId}/keywords/expand`, { method: 'POST' });
      setMsg(t('kwSuggested', { n: r.suggested.length }));
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
      <h3>{t('keywords')}</h3>
      <form onSubmit={add} className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="live wallpaper, depth wallpaper" required />
        <button type="submit" className="primary">
          {t('add')}
        </button>
        <button type="button" onClick={expand}>
          {t('suggestVariants')}
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
                {k.status !== 'ACTIVE' && <button onClick={() => setStatus(k, 'ACTIVE')}>{t('activate')}</button>}{' '}
                {k.status === 'ACTIVE' && <button onClick={() => setStatus(k, 'PAUSED')}>{t('pause')}</button>}{' '}
                {k.status === 'SUGGESTED' && <button onClick={() => setStatus(k, 'REJECTED')}>{t('reject')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <Empty>{t('noKeywords')}</Empty>}
    </section>
  );
}

function Discovery({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const t = useT(M);
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
      <h3>{t('discovery')}</h3>
      <div className="row">
        <button className="primary" onClick={run} disabled={!!job && ACTIVE.includes(job.status)}>
          {t('runDiscovery')}
        </button>
        {shown && (
          <span>
            {t('lastRun')} <Status s={shown.status} /> {shown.progress}% · {fmtTime(shown.createdAt)}
            {shown.error && <span className="error-inline"> {shown.error.code}: {shown.error.message}</span>}
          </span>
        )}
      </div>
      <ErrorBox error={err} />
      {coverage.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('thPlatform')}</th>
              <th>{t('thKeyword')}</th>
              <th>{t('thOperation')}</th>
              <th>{t('thStatus')}</th>
              <th>{t('thResults')}</th>
              <th>{t('thReason')}</th>
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
                <td>{c.results === null ? <span className="muted">{t('na')}</span> : c.results}</td>
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
  const t = useT(M);
  const [status, setStatus] = useState<CandidateStatus>('PENDING');
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
      setMsg(`${action === 'approve' ? t('approvedMsg', { n: r.approved.length }) : t('rejectedMsg', { n: r.rejected.length })}. ${r.warnings.join(' ')}`);
      setSelected([]);
      list.reload();
    } catch (x) {
      setMsg(errText(x));
    }
  }
  return (
    <section>
      <h3>{t('reviewQueue')}</h3>
      <div className="row">
        <select value={status} onChange={(e) => (setStatus(e.target.value as CandidateStatus), setCursor(null))}>
          {(Object.keys(CANDIDATE_STATUSES) as CandidateStatus[]).map((s) => (
            <option key={s} value={s}>
              {t(CANDIDATE_STATUSES[s].opt)}
            </option>
          ))}
        </select>
        <input className="narrow" type="number" min={0} max={100} value={minScore} onChange={(e) => (setMinScore(e.target.value), setCursor(null))} placeholder={t('minScore')} />
        <button className="primary" disabled={!selected.length} onClick={() => decide('approve')}>
          {t('approveTrack', { n: selected.length })}
        </button>
        <button disabled={!selected.length} onClick={() => decide('reject')}>
          {t('rejectN', { n: selected.length })}
        </button>
        <Loading on={list.loading} />
      </div>
      {msg && <p className="small">{msg}</p>}
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th />
            <th>{t('thAccount')}</th>
            <th>{t('thScore')}</th>
            <th>{t('thType')}</th>
            <th>{t('thFollowers')}</th>
            <th>{t('thEvidence')}</th>
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
                  {c.account.platform} · @{c.account.username} {c.decidedBy && t('decidedBy', { who: c.decidedBy })}
                </div>
              </td>
              <td>
                <b>{Math.round(c.score)}</b>
              </td>
              <td className="small">
                {c.classification}
                <div className="muted">{t('confidence', { v: c.evidence.confidence ?? '—' })}</div>
              </td>
              <td>{fmtNum(c.evidence.profile?.followers ?? null)}</td>
              <td className="small">
                <details>
                  <summary>{t('reasons', { n: (c.evidence.reasons ?? []).length })}</summary>
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
      {list.data?.items.length === 0 && <Empty>{t(CANDIDATE_STATUSES[status].empty)}</Empty>}
      {list.data?.nextCursor && <button onClick={() => setCursor(list.data!.nextCursor)}>{t('nextPage')}</button>}
      {cursor && <button onClick={() => setCursor(null)}>{t('firstPage')}</button>}
    </section>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const t = useT(M);
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
        <a href="#/projects">{t('backToProjects')}</a>
      </p>
      <ErrorBox error={p.error} />
      {p.data && (
        <>
          <h2>
            {p.data.name} <Status s={p.data.status} />
          </h2>
          <p className="muted small">
            {t('projectMeta', { platforms: p.data.platforms.join(', ') || '—', languages: p.data.languages.join(', ') || '—', tz: p.data.timezone })}{' '}
            <a href={`#/explore?projectId=${id}`}>{t('projectContent')}</a>
          </p>
          <div className="row small">
            <span>{t('syncEvery', { n: String(s.sync_interval_minutes) })}</span>·
            <span>{t('scheduledDiscovery', { v: s.discovery_every_hours ? t('everyHours', { n: String(s.discovery_every_hours) }) : t('off') })}</span>·
            <span>{t('autoTrack', { v: s.auto_track ? t('autoTrackOn', { min: String(s.auto_track_min_score), max: String(s.auto_track_max_per_run) }) : t('off') })}</span>
            <button onClick={() => patch({ status: p.data!.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })}>{p.data.status === 'ACTIVE' ? t('pauseProject') : t('resumeProject')}</button>
            <button onClick={() => patch({ settings: { discovery_every_hours: s.discovery_every_hours ? 0 : 24 } })}>{s.discovery_every_hours ? t('dailyOff') : t('dailyOn')}</button>
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
