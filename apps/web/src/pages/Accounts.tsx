import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Account, type AccountDetail, type Job, type Page, type Post, type Project } from '../api.ts';
import { defineMessages, useT } from '../i18n.tsx';
import { ErrorBox, ExternalLink, fmtNum, fmtTime, Status, useLoad } from '../ui.tsx';

const M = defineMessages({
  title: ['Accounts', 'Tài khoản'],
  inputPlaceholder: ['Profile URL, e.g. https://bsky.app/profile/bsky.app', 'URL hồ sơ, ví dụ https://bsky.app/profile/bsky.app'],
  noProject: ['(no project)', '(không thuộc dự án)'],
  resolving: ['Resolving…', 'Đang xác định…'],
  trackAccount: ['Track account', 'Theo dõi tài khoản'],
  tracked: ['Tracked {name}. Sync job {job} queued. {warnings}', 'Đã theo dõi {name}. Tác vụ đồng bộ {job} đã vào hàng đợi. {warnings}'],
  thAccount: ['Account', 'Tài khoản'],
  thPlatform: ['Platform', 'Nền tảng'],
  thStatus: ['Status', 'Trạng thái'],
  thFollowers: ['Followers', 'Người theo dõi'],
  thPosts: ['Posts', 'Bài đăng'],
  thCollected: ['Collected', 'Thu thập lúc'],
  noAccounts: ['No accounts yet — paste a profile URL above.', 'Chưa có tài khoản nào — hãy dán URL hồ sơ ở trên.'],
  back: ['← Accounts', '← Tài khoản'],
  statFollowers: ['followers', 'người theo dõi'],
  statFollowing: ['following', 'đang theo dõi'],
  statPostsOnPlatform: ['posts on platform', 'bài đăng trên nền tảng'],
  statPostsStored: ['posts stored', 'bài đăng đã lưu'],
  metricsLine: [
    'Metrics collected {at} via {provider} (policy {policy}). Last successful sync {last}.',
    'Chỉ số thu thập lúc {at} qua {provider} (chính sách {policy}). Lần đồng bộ thành công gần nhất: {last}.',
  ],
  syncNow: ['Sync now', 'Đồng bộ ngay'],
  refreshMetrics: ['Refresh metrics', 'Làm mới chỉ số'],
  job: ['Job', 'Tác vụ'],
  jobResult: [' · {new} new, {updated} updated', ' · {new} mới, {updated} cập nhật'],
  postsHeading: ['Posts', 'Bài đăng'],
  thPublished: ['Published', 'Đăng lúc'],
  thType: ['Type', 'Loại'],
  thContent: ['Content', 'Nội dung'],
  thViews: ['Views', 'Lượt xem'],
  thLikes: ['Likes', 'Lượt thích'],
  thComments: ['Comments', 'Bình luận'],
  thShares: ['Shares', 'Chia sẻ'],
  noText: ['(no text)', '(không có nội dung)'],
  noPosts: ['No posts stored yet — run a sync.', 'Chưa lưu bài đăng nào — hãy chạy đồng bộ.'],
  syncHistory: ['Sync history', 'Lịch sử đồng bộ'],
  thStarted: ['Started', 'Bắt đầu'],
  thOperation: ['Operation', 'Thao tác'],
  thRequests: ['Requests', 'Yêu cầu'],
  thRecords: ['Records', 'Bản ghi'],
  thLatency: ['Latency', 'Độ trễ'],
  thErrorWarnings: ['Error / warnings', 'Lỗi / cảnh báo'],
});

export function Accounts() {
  const t = useT(M);
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
      setMsg({ kind: 'ok', text: t('tracked', { name: r.account.username ?? r.account.externalId, job: r.job_id ?? '—', warnings: r.warnings.join(' ') }) });
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
      <h2>{t('title')}</h2>
      <form onSubmit={track} className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('inputPlaceholder')} required maxLength={500} />
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{t('noProject')}</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? t('resolving') : t('trackAccount')}
        </button>
      </form>
      {msg && <div className={msg.kind === 'ok' ? 'ok' : 'error'}>{msg.text}</div>}
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>{t('thAccount')}</th>
            <th>{t('thPlatform')}</th>
            <th>{t('thStatus')}</th>
            <th>{t('thFollowers')}</th>
            <th>{t('thPosts')}</th>
            <th>{t('thCollected')}</th>
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
      {list.data?.items.length === 0 && <p className="muted">{t('noAccounts')}</p>}
    </>
  );
}

export function AccountPage({ id }: { id: string }) {
  const t = useT(M);
  const acc = useLoad(() => api<AccountDetail>(`/accounts/${id}`), [id]);
  const posts = useLoad(() => api<Page<Post>>(`/posts?accountId=${id}&limit=50`), [id]);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!job || !['QUEUED', 'RUNNING'].includes(job.status)) return;
    const timer = setTimeout(async () => {
      const j = await api<Job>(`/jobs/${job.id}`);
      setJob(j);
      if (!['QUEUED', 'RUNNING'].includes(j.status)) {
        acc.reload();
        posts.reload();
      }
    }, 1500);
    return () => clearTimeout(timer);
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
        <a href="#/accounts">{t('back')}</a>
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
              <b>{fmtNum(a.metrics?.followers, a.metrics?.missing?.followers)}</b> {t('statFollowers')}
            </div>
            <div>
              <b>{fmtNum(a.metrics?.following, a.metrics?.missing?.following)}</b> {t('statFollowing')}
            </div>
            <div>
              <b>{fmtNum(a.metrics?.postsCount, a.metrics?.missing?.postsCount)}</b> {t('statPostsOnPlatform')}
            </div>
            <div>
              <b>{a.postCount}</b> {t('statPostsStored')}
            </div>
          </div>
          <p className="muted small">
            {t('metricsLine', { at: fmtTime(a.metrics?.collectedAt), provider: a.metrics?.providerId ?? '—', policy: a.metrics?.policyId ?? '—', last: fmtTime(a.sync?.lastSuccessAt) })}
          </p>
          <div className="row">
            <button className="primary" onClick={sync} disabled={!!job && ['QUEUED', 'RUNNING'].includes(job.status)}>
              {t('syncNow')}
            </button>
            <button onClick={refresh} disabled={!!job && ['QUEUED', 'RUNNING'].includes(job.status)}>
              {t('refreshMetrics')}
            </button>
            {job && (
              <span>
                {t('job')} <Status s={job.status} /> {job.progress}% {job.error && <span className="error-inline">{job.error.code}: {job.error.message}</span>}
                {job.result && t('jobResult', { new: String(job.result.postsNew ?? 0), updated: String(job.result.postsUpdated ?? 0) })}
              </span>
            )}
          </div>
          <h3>{t('postsHeading')}</h3>
          <table>
            <thead>
              <tr>
                <th>{t('thPublished')}</th>
                <th>{t('thType')}</th>
                <th>{t('thContent')}</th>
                <th>{t('thViews')}</th>
                <th>{t('thLikes')}</th>
                <th>{t('thComments')}</th>
                <th>{t('thShares')}</th>
                <th>{t('thCollected')}</th>
              </tr>
            </thead>
            <tbody>
              {posts.data?.items.map((p) => (
                <tr key={p.id}>
                  <td className="small">{fmtTime(p.publishedAt)}</td>
                  <td>{p.contentType}</td>
                  <td className="caption">
                    <ExternalLink href={p.url}>{p.title ?? (p.caption ? p.caption.slice(0, 160) : t('noText'))}</ExternalLink>
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
          {posts.data?.items.length === 0 && <p className="muted">{t('noPosts')}</p>}
          <h3>{t('syncHistory')}</h3>
          <table>
            <thead>
              <tr>
                <th>{t('thStarted')}</th>
                <th>{t('thOperation')}</th>
                <th>{t('thStatus')}</th>
                <th>{t('thRequests')}</th>
                <th>{t('thRecords')}</th>
                <th>{t('thLatency')}</th>
                <th>{t('thErrorWarnings')}</th>
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
