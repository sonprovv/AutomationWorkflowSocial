import { useState } from 'react';
import { api, type Dashboard as D, type Page, type PostFull, type Project } from '../api.ts';
import { defineMessages, useT } from '../i18n.tsx';
import { Empty, ErrorBox, ExternalLink, fmtNum, fmtTime, Loading, Status, useLoad } from '../ui.tsx';

const M = defineMessages({
  noText: ['(no text)', '(không có nội dung)'],
  postMeta: ['{platform} · @{user} · published {published} · collected {collected}', '{platform} · @{user} · đăng lúc {published} · thu thập lúc {collected}'],
  likes: ['likes', 'lượt thích'],
  title: ['Dashboard', 'Tổng quan'],
  allProjects: ['All projects', 'Tất cả dự án'],
  tileProjects: ['Active projects', 'Dự án đang hoạt động'],
  tileTracked: ['Tracked accounts', 'Tài khoản đang theo dõi'],
  tilePosts: ['Posts stored', 'Bài đăng đã lưu'],
  tile24h: ['Collected in 24 h', 'Thu thập trong 24 giờ'],
  tile7d: ['Collected in 7 d', 'Thu thập trong 7 ngày'],
  tileCandidates: ['Candidates to review', 'Ứng viên chờ duyệt'],
  tileKeywords: ['Active keywords', 'Từ khóa đang hoạt động'],
  tileUnavailable: ['Unavailable posts', 'Bài đăng không còn truy cập được'],
  postsPerDay: ['Posts per day (14 days, by publish time)', 'Bài đăng mỗi ngày (14 ngày, theo thời điểm đăng)'],
  noPosts14d: ['No posts in the last 14 days.', 'Không có bài đăng nào trong 14 ngày qua.'],
  jobs24h: ['Jobs (24 h)', 'Tác vụ (24 giờ)'],
  noJobs: ['No jobs.', 'Không có tác vụ nào.'],
  stuck: ['{n} job(s) look stuck — see the Job Monitor.', '{n} tác vụ có vẻ bị treo — xem trang Giám sát tác vụ.'],
  scheduler: ['Scheduler', 'Bộ lập lịch'],
  noSchedules: ['No schedules yet — they are created on the first scheduler tick.', 'Chưa có lịch chạy — lịch sẽ được tạo ở lượt chạy đầu tiên của bộ lập lịch.'],
  next: ['next {time}', 'lần tới {time}'],
  latestPosts: ['Latest posts', 'Bài đăng mới nhất'],
  noPostsYet: ['No posts yet — track an account or run discovery.', 'Chưa có bài đăng — hãy theo dõi một tài khoản hoặc chạy khám phá.'],
  mostLiked: ['Most liked (7 days)', 'Nhiều lượt thích nhất (7 ngày)'],
  noLiked7d: ['No posts published in the last 7 days have a like count.', 'Không có bài đăng nào trong 7 ngày qua có số lượt thích.'],
  coverage: ['Coverage & usage today', 'Độ phủ và mức sử dụng hôm nay'],
  thProvider: ['Provider', 'Nhà cung cấp'],
  thPhase0: ['Phase 0 status', 'Trạng thái giai đoạn 0'],
  thEnabled: ['Enabled', 'Đã bật'],
  thHealth: ['Health', 'Tình trạng'],
  thUsed: ['Used today', 'Đã dùng hôm nay'],
  thReserved: ['Reserved now', 'Đang giữ chỗ'],
  thCost: ['Cost today', 'Chi phí hôm nay'],
  yes: ['yes', 'có'],
  no: ['no', 'không'],
  healthy: ['healthy', 'hoạt động tốt'],
  unhealthy: ['unhealthy', 'gặp sự cố'],
});
type K = keyof typeof M;

/** Compact post row: text first, then source and times (provenance stays visible), likes on the right. */
export function PostLine({ p }: { p: PostFull }) {
  const t = useT(M);
  return (
    <tr>
      <td className="caption">
        <ExternalLink href={p.url}>{p.title ?? (p.caption ? p.caption.slice(0, 140) : t('noText'))}</ExternalLink>
        <div className="muted small" style={{ marginTop: 3 }}>
          {t('postMeta', {
            platform: p.platform,
            user: p.account.username ?? '—',
            published: fmtTime(p.publishedAt),
            collected: fmtTime(p.metrics?.collectedAt ?? p.provenance.lastCollectedAt),
          })}
        </div>
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <b>{fmtNum(p.metrics?.likes, p.metrics?.missing?.likes)}</b>
        <div className="muted small">{t('likes')}</div>
      </td>
    </tr>
  );
}

export function Dashboard() {
  const t = useT(M);
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [projectId, setProjectId] = useState('');
  const d = useLoad(() => api<D>(`/dashboard${projectId ? `?projectId=${projectId}` : ''}`), [projectId]);
  const max = Math.max(1, ...(d.data?.postsPerDay.map((x) => x.posts) ?? [1]));
  const c = d.data?.counts;
  const tiles: [K, number | undefined][] = [
    ['tileProjects', c?.projects],
    ['tileTracked', c?.trackedAccounts],
    ['tilePosts', c?.posts],
    ['tile24h', c?.newPosts24h],
    ['tile7d', c?.newPosts7d],
    ['tileCandidates', c?.pendingCandidates],
    ['tileKeywords', c?.activeKeywords],
    ['tileUnavailable', c?.unavailablePosts],
  ];
  return (
    <>
      <div className="row">
        <h2 style={{ margin: 0 }}>{t('title')}</h2>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">{t('allProjects')}</option>
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
                <span className="muted small">{t(label)}</span>
              </div>
            ))}
          </div>
          <div className="grid2">
            <section>
              <h3>{t('postsPerDay')}</h3>
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
              {d.data.postsPerDay.length === 0 && <p className="muted">{t('noPosts14d')}</p>}
              <h3>{t('jobs24h')}</h3>
              <p>
                {Object.entries(d.data.jobs.byStatus).map(([s, n]) => (
                  <span key={s} style={{ marginRight: 12 }}>
                    <Status s={s} /> {n}
                  </span>
                ))}
                {Object.keys(d.data.jobs.byStatus).length === 0 && <span className="muted">{t('noJobs')}</span>}
              </p>
              {d.data.jobs.stuck > 0 && <div className="notice">{t('stuck', { n: d.data.jobs.stuck })}</div>}
              <h3>
                {t('scheduler')} {d.data.scheduler.paused && <Status s="PAUSED" />}
              </h3>
              {d.data.scheduler.next.length === 0 && <p className="muted">{t('noSchedules')}</p>}
              <table>
                <tbody>
                  {d.data.scheduler.next.map((s) => (
                    <tr key={s.id}>
                      <td>{s.workflowKey}</td>
                      <td className="small">{t('next', { time: fmtTime(s.nextRunAt) })}</td>
                      <td>
                        <Status s={s.lastStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section>
              <h3>{t('latestPosts')}</h3>
              <table>
                <tbody>
                  {d.data.latestPosts.map((p) => (
                    <PostLine key={p.id} p={p} />
                  ))}
                </tbody>
              </table>
              {d.data.latestPosts.length === 0 && <Empty>{t('noPostsYet')}</Empty>}
              <h3>{t('mostLiked')}</h3>
              <p className="muted small">{d.data.topPostsByLikes7d.note}</p>
              {d.data.topPostsByLikes7d.items.length === 0 && <p className="muted">{t('noLiked7d')}</p>}
              <table>
                <tbody>
                  {d.data.topPostsByLikes7d.items.map((p) => (
                    <PostLine key={p.id} p={p} />
                  ))}
                </tbody>
              </table>
            </section>
          </div>
          <h3>{t('coverage')}</h3>
          <table>
            <thead>
              <tr>
                <th>{t('thProvider')}</th>
                <th>{t('thPhase0')}</th>
                <th>{t('thEnabled')}</th>
                <th>{t('thHealth')}</th>
                <th>{t('thUsed')}</th>
                <th>{t('thReserved')}</th>
                <th>{t('thCost')}</th>
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
                  <td>{p.enabled ? t('yes') : <span className="muted">{t('no')}</span>}</td>
                  <td className="small">
                    {p.healthy === null ? '—' : p.healthy ? t('healthy') : t('unhealthy')} {p.checkedAt && `(${fmtTime(p.checkedAt)})`}
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
