import { useEffect, useState } from 'react';
import { api, type ExportRow, type Job, type JobStats, type Provider, type Workflow } from '../api.ts';
import { defineMessages, useT } from '../i18n.tsx';
import { ACTIVE, Empty, errText, ErrorBox, fmtTime, Status, useLoad } from '../ui.tsx';

const M = defineMessages({
  // Job Monitor
  jobsTitle: ['Job Monitor', 'Giám sát tác vụ'],
  last24h: ['Last 24 h', '24 giờ qua'],
  noJobs: ['No jobs.', 'Không có tác vụ.'],
  stuckJobs: ['Stuck jobs: {ids} (running longer than 1.5 × job timeout).', 'Tác vụ bị treo: {ids} (chạy lâu hơn 1,5 × thời gian chờ của tác vụ).'],
  deadLetter: ['Dead letter (failed, 24 h)', 'Tác vụ lỗi (dead letter, 24 giờ)'],
  none: ['none', 'không có'],
  retry: ['Retry', 'Thử lại'],
  cancel: ['Cancel', 'Hủy'],
  recentJobs: ['Recent jobs', 'Tác vụ gần đây'],
  colCreated: ['Created', 'Ngày tạo'],
  colJob: ['Job', 'Tác vụ'],
  colStatus: ['Status', 'Trạng thái'],
  colProgress: ['Progress', 'Tiến độ'],
  colAttempts: ['Attempts', 'Số lần thử'],
  colErrors: ['Error / warnings', 'Lỗi / cảnh báo'],
  // Schedules
  schedulesTitle: ['Schedules', 'Lịch chạy'],
  resumeScheduler: ['Resume scheduler', 'Tiếp tục bộ lập lịch'],
  pauseAll: ['Pause all schedules', 'Tạm dừng mọi lịch chạy'],
  colWorkflow: ['Workflow', 'Quy trình'],
  colSchedule: ['Schedule', 'Lịch chạy'],
  colNextRun: ['Next run', 'Lần chạy tới'],
  colLastRun: ['Last run', 'Lần chạy trước'],
  colEnabled: ['Enabled', 'Bật'],
  every: ['every', 'mỗi'],
  min: ['min', 'phút'],
  runNow: ['Run now', 'Chạy ngay'],
  schedulesNote: [
    'Missed runs while the computer was off run once on the next start (no replay). Schedules never start duplicate work: an identical active job makes the run SKIPPED.',
    'Các lần chạy bị lỡ khi máy tắt sẽ chạy một lần ở lần khởi động tiếp theo (không chạy bù từng lần). Lịch chạy không bao giờ tạo việc trùng lặp: nếu đã có tác vụ giống hệt đang chạy, lần chạy sẽ là SKIPPED.',
  ],
  // Exports
  exportsTitle: ['Exports', 'Xuất dữ liệu'],
  exportsNote: [
    'Create exports from the Content Explorer. Files expire after the configured number of days.',
    'Tạo bản xuất dữ liệu từ trang Khám phá nội dung. Tệp sẽ hết hạn sau số ngày đã cấu hình.',
  ],
  colFormat: ['Format', 'Định dạng'],
  colRows: ['Rows', 'Số dòng'],
  colWithheld: ['Withheld by policy', 'Bị giữ lại theo chính sách'],
  colFile: ['File', 'Tệp'],
  withheldRow: ['{provider}: {posts} post(s), {accounts} account(s)', '{provider}: {posts} bài viết, {accounts} tài khoản'],
  expires: ['expires {time}', 'hết hạn {time}'],
  noExports: ['No exports yet.', 'Chưa có bản xuất dữ liệu nào.'],
  // Data Sources
  sourcesTitle: ['Data Sources', 'Nguồn dữ liệu'],
  system: ['System', 'Hệ thống'],
  queue: ['queue', 'hàng đợi'],
  inlineNote: [
    ' — dev mode: jobs and schedules run inside the API. Install Redis/Memurai for the separate worker.',
    ' — chế độ phát triển: tác vụ và lịch chạy chạy bên trong API. Cài Redis/Memurai để dùng worker riêng.',
  ],
  colProvider: ['Provider', 'Nhà cung cấp'],
  colPlatform: ['Platform', 'Nền tảng'],
  colPhase0: ['Phase 0 status', 'Trạng thái Phase 0'],
  colPolicy: ['Policy', 'Chính sách'],
  colUsage: ['Usage today', 'Đã dùng hôm nay'],
  colHealth: ['Health', 'Tình trạng'],
  yes: ['yes', 'có'],
  noCredential: ['no (credential missing)', 'không (thiếu thông tin xác thực)'],
  noVerified: ['no (not verified)', 'không (chưa xác minh)'],
  noAdapter: ['no adapter', 'chưa có adapter'],
  polHistory: ['history', 'lịch sử'],
  polDerived: ['derived', 'chỉ số suy ra'],
  polExport: ['export', 'xuất'],
  keepDays: [' · keep ≤{n}d', ' · lưu ≤{n} ngày'],
  healthy: ['healthy', 'hoạt động tốt'],
  unhealthy: ['unhealthy', 'có lỗi'],
  testing: ['Testing…', 'Đang kiểm tra…'],
  test: ['Test', 'Kiểm tra'],
  sourcesNote: [
    '✗ means not allowed until the Product Owner approves the provider policy (deny-by-default). Exports leave such rows out and say so.',
    '✗ nghĩa là chưa được phép cho đến khi Product Owner duyệt chính sách của nhà cung cấp (mặc định từ chối). Bản xuất dữ liệu bỏ các dòng đó ra và có ghi rõ.',
  ],
});

/* ---------------- Job Monitor ---------------- */
export function Jobs() {
  const t = useT(M);
  const list = useLoad(() => api<{ items: Job[] }>('/jobs?limit=100'), []);
  const stats = useLoad(() => api<JobStats>('/jobs/stats'), []);
  useEffect(() => {
    const timer = setInterval(() => (list.reload(), stats.reload()), 3000);
    return () => clearInterval(timer);
  }, [list.reload, stats.reload]);
  async function act(id: string, action: 'cancel' | 'retry') {
    await api(`/jobs/${id}/${action}`, { method: 'POST' }).catch(() => {});
    list.reload();
  }
  const s = stats.data;
  return (
    <>
      <h2>{t('jobsTitle')}</h2>
      <ErrorBox error={list.error ?? stats.error} />
      {s && (
        <div className="grid2">
          <section>
            <h3>{t('last24h')}</h3>
            <p>
              {Object.entries(s.byStatus).map(([k, n]) => (
                <span key={k} style={{ marginRight: 12 }}>
                  <Status s={k} /> {n}
                </span>
              ))}
              {Object.keys(s.byStatus).length === 0 && <span className="muted">{t('noJobs')}</span>}
            </p>
            <table>
              <tbody>
                {Object.entries(s.byName).map(([name, by]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="small">
                      {Object.entries(by)
                        .map(([k, n]) => `${k} ${n}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.active.some((j) => j.stuck) && (
              <div className="notice">
                {t('stuckJobs', {
                  ids: s.active
                    .filter((j) => j.stuck)
                    .map((j) => j.id.slice(0, 8))
                    .join(', '),
                })}
              </div>
            )}
          </section>
          <section>
            <h3>{t('deadLetter')}</h3>
            <p className="small">
              {Object.entries(s.deadLetter.byErrorCode)
                .map(([k, n]) => `${k} × ${n}`)
                .join(' · ') || <span className="muted">{t('none')}</span>}
            </p>
            <table>
              <tbody>
                {s.deadLetter.recent.map((j) => (
                  <tr key={j.id}>
                    <td className="small">{fmtTime(j.finishedAt)}</td>
                    <td>{j.name}</td>
                    <td className="small">
                      {j.errorCode}: {j.errorMessage?.slice(0, 160)}
                    </td>
                    <td>
                      <button onClick={() => act(j.id, 'retry')}>{t('retry')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
      <h3>{t('recentJobs')}</h3>
      <table>
        <thead>
          <tr>
            <th>{t('colCreated')}</th>
            <th>{t('colJob')}</th>
            <th>{t('colStatus')}</th>
            <th>{t('colProgress')}</th>
            <th>{t('colAttempts')}</th>
            <th>{t('colErrors')}</th>
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
              <td className="small">{[j.error ? `${j.error.code}: ${j.error.message ?? ''}` : '', ...j.warnings.slice(0, 2)].filter(Boolean).join(' · ')}</td>
              <td>
                {ACTIVE.includes(j.status) && <button onClick={() => act(j.id, 'cancel')}>{t('cancel')}</button>}
                {['FAILED', 'CANCELLED', 'PARTIAL_SUCCESS'].includes(j.status) && <button onClick={() => act(j.id, 'retry')}>{t('retry')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* ---------------- Automations ---------------- */
export function Workflows() {
  const t = useT(M);
  const list = useLoad(() => api<{ paused: boolean; items: Workflow[] }>('/workflows'), []);
  const [msg, setMsg] = useState<string | null>(null);
  async function call(path: string, method: string, body?: unknown) {
    try {
      const r = await api<{ status?: string; notes?: string[] }>(path, { method, body });
      if (r?.status) setMsg(`${r.status} ${(r.notes ?? []).join(' ')}`);
      list.reload();
    } catch (x) {
      setMsg(errText(x));
    }
  }
  return (
    <>
      <div className="row">
        <h2 style={{ margin: 0 }}>{t('schedulesTitle')}</h2>
        {list.data?.paused ? (
          <>
            <Status s="PAUSED" /> <button onClick={() => call('/scheduler/resume', 'POST')}>{t('resumeScheduler')}</button>
          </>
        ) : (
          <button onClick={() => call('/scheduler/pause', 'POST')}>{t('pauseAll')}</button>
        )}
      </div>
      {msg && <p className="small">{msg}</p>}
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>{t('colWorkflow')}</th>
            <th>{t('colSchedule')}</th>
            <th>{t('colNextRun')}</th>
            <th>{t('colLastRun')}</th>
            <th>{t('colEnabled')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((w) => (
            <tr key={w.id}>
              <td>
                {w.workflowKey}
                <div className="muted small">{w.description}</div>
              </td>
              <td className="small">
                {w.cron ? (
                  `cron ${w.cron} (${w.timezone})`
                ) : (
                  <>
                    {t('every')}{' '}
                    <input
                      className="narrow"
                      style={{ width: 70 }}
                      type="number"
                      min={1}
                      defaultValue={w.everyMinutes ?? 60}
                      onBlur={(e) => Number(e.target.value) !== w.everyMinutes && call(`/workflows/${w.id}`, 'PATCH', { everyMinutes: Number(e.target.value) })}
                    />{' '}
                    {t('min')}
                  </>
                )}
              </td>
              <td className="small">{w.enabled ? fmtTime(w.nextRunAt) : '—'}</td>
              <td className="small">
                {fmtTime(w.lastRunAt)} <Status s={w.lastStatus} />
                {w.lastResult?.notes?.length ? <div className="muted">{w.lastResult.notes.slice(0, 2).join(' · ')}</div> : null}
              </td>
              <td>
                <input type="checkbox" checked={w.enabled} onChange={(e) => call(`/workflows/${w.id}`, 'PATCH', { enabled: e.target.checked })} />
              </td>
              <td>
                <button onClick={() => call(`/workflows/${w.id}/run`, 'POST')}>{t('runNow')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t('schedulesNote')}</p>
    </>
  );
}

/* ---------------- Exports ---------------- */
export function Exports() {
  const t = useT(M);
  const list = useLoad(() => api<{ items: ExportRow[] }>('/exports'), []);
  return (
    <>
      <h2>{t('exportsTitle')}</h2>
      <p className="muted small">{t('exportsNote')}</p>
      <ErrorBox error={list.error} />
      <table>
        <thead>
          <tr>
            <th>{t('colCreated')}</th>
            <th>{t('colFormat')}</th>
            <th>{t('colStatus')}</th>
            <th>{t('colRows')}</th>
            <th>{t('colWithheld')}</th>
            <th>{t('colFile')}</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((e) => (
            <tr key={e.id}>
              <td className="small">{fmtTime(e.createdAt)}</td>
              <td>{e.format}</td>
              <td>
                <Status s={e.status} />
                {e.error && <div className="error-inline small">{e.error}</div>}
              </td>
              <td className="small">{Object.entries(e.rowCounts).map(([k, n]) => `${k} ${n}`).join(' · ')}</td>
              <td className="small">{e.withheld.length ? e.withheld.map((w) => t('withheldRow', { provider: w.providerId, posts: w.posts, accounts: w.accounts })).join('; ') : '—'}</td>
              <td className="small">
                {e.downloadUrl ? <a href={e.downloadUrl}>{e.fileName}</a> : '—'} {e.sizeBytes ? `(${Math.ceil(e.sizeBytes / 1024)} KB)` : ''}
                <div className="muted">{t('expires', { time: fmtTime(e.expiresAt) })}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data?.items.length === 0 && <Empty>{t('noExports')}</Empty>}
    </>
  );
}

/* ---------------- Data Sources ---------------- */
export function Sources() {
  const t = useT(M);
  const health = useLoad(() => api<{ status: string; queueDriver: string }>('/health/ready').catch(() => ({ status: 'not_ready', queueDriver: '?' })), []);
  const providers = useLoad(() => api<{ items: Provider[] }>('/providers'), []);
  const [testing, setTesting] = useState<string | null>(null);
  return (
    <>
      <h2>{t('sourcesTitle')}</h2>
      {health.data && (
        <p>
          {t('system')} <Status s={health.data.status === 'ready' ? 'SUCCEEDED' : 'FAILED'} /> · {t('queue')} <code>{health.data.queueDriver}</code>
          {health.data.queueDriver === 'inline' && <span className="muted">{t('inlineNote')}</span>}
        </p>
      )}
      <ErrorBox error={providers.error} />
      <table>
        <thead>
          <tr>
            <th>{t('colProvider')}</th>
            <th>{t('colPlatform')}</th>
            <th>{t('colPhase0')}</th>
            <th>{t('colEnabled')}</th>
            <th>{t('colPolicy')}</th>
            <th>{t('colUsage')}</th>
            <th>{t('colHealth')}</th>
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
              <td>{p.enabled ? t('yes') : p.implemented ? (p.credentialConfigured === false ? t('noCredential') : t('noVerified')) : t('noAdapter')}</td>
              <td className="small">
                {t('polHistory')} {p.policy.allowHistoricalSnapshots ? '✓' : '✗'} · {t('polDerived')} {p.policy.allowDerivedMetrics ? '✓' : '✗'} · {t('polExport')} {p.policy.allowExport ? '✓' : '✗'}
                {p.policy.retentionDays ? t('keepDays', { n: p.policy.retentionDays }) : ''}
              </td>
              <td className="small">{p.usageToday ? Object.entries(p.usageToday).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—'}</td>
              <td className="small">
                {p.lastHealth ? (p.lastHealth.healthy ? t('healthy') : t('unhealthy')) : '—'} {p.checkedAt ? `(${fmtTime(p.checkedAt)})` : ''}
              </td>
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
                    {testing === p.id ? t('testing') : t('test')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t('sourcesNote')}</p>
    </>
  );
}
