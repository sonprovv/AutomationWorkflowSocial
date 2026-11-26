import { useState } from 'react';
import { api, type Page, type Project } from '../api.ts';
import { defineMessages, useT } from '../i18n.tsx';
import { Empty, errText, ErrorBox, fmtTime, Status, useLoad } from '../ui.tsx';

const M = defineMessages({
  title: ['Reports & alerts', 'Báo cáo và cảnh báo'],
  queued: ['Report queued — refresh in a moment.', 'Đã xếp hàng tạo báo cáo — hãy làm mới sau giây lát.'],
  buildDaily: ['Build daily report', 'Tạo báo cáo hằng ngày'],
  buildSendDaily: ['Build & send daily report', 'Tạo và gửi báo cáo hằng ngày'],
  buildWeekly: ['Build weekly report', 'Tạo báo cáo hằng tuần'],
  sendTest: ['Send test notification', 'Gửi thông báo thử'],
  channels: ['Channels configured: {list}', 'Kênh đã cấu hình: {list}'],
  noChannels: ['none (set TELEGRAM_*, SMTP_URL/EMAIL_*, WEBHOOK_* in .env)', 'chưa có (đặt TELEGRAM_*, SMTP_URL/EMAIL_*, WEBHOOK_* trong .env)'],
  thCreated: ['Created', 'Ngày tạo'],
  thKind: ['Kind', 'Loại'],
  thStatus: ['Status', 'Trạng thái'],
  thPeriod: ['Period', 'Kỳ báo cáo'],
  noReports: ['No reports yet.', 'Chưa có báo cáo nào.'],
  downloadExcel: ['Download Excel', 'Tải file Excel'],
  selectReport: ['Select a report.', 'Chọn một báo cáo.'],
  notifLog: ['Notification log', 'Nhật ký thông báo'],
  thChannel: ['Channel', 'Kênh'],
  thType: ['Type', 'Loại'],
  thTitleError: ['Title / error', 'Tiêu đề / lỗi'],
});

type ReportRow = { id: string; projectId: string; kind: string; status: string; periodStart: string; periodEnd: string; createdAt: string };
type ReportFull = ReportRow & { markdown: string; exportDownloadUrl: string | null };
type Notif = { id: string; channel: string; type: string; status: string; attempts: number; title: string; error: string | null; createdAt: string };

/** Reports & Alerts (Master Plan §10): report history, the report text, Excel link, notification log. */
export function Reports() {
  const t = useT(M);
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const initialId = new URLSearchParams(location.hash.split('?')[1] ?? '').get('id');
  const [selected, setSelected] = useState<string | null>(initialId);
  const list = useLoad(() => api<{ items: ReportRow[] }>('/reports?limit=50'), []);
  const one = useLoad(() => (selected ? api<ReportFull>(`/reports/${selected}`) : Promise.resolve(null)), [selected]);
  const notifs = useLoad(() => api<{ channels: string[]; items: Notif[] }>('/notifications?limit=30'), []);
  const [projectId, setProjectId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const pid = projectId || projects.data?.items[0]?.id || '';
  async function create(kind: 'daily' | 'weekly', notify: boolean) {
    try {
      await api('/reports', { method: 'POST', body: { projectId: pid, kind, notify } });
      setMsg(t('queued'));
      setTimeout(list.reload, 2500);
    } catch (x) {
      setMsg(errText(x));
    }
  }
  async function test() {
    const r = await api<{ results: { channel: string; status: string; error?: string }[] }>('/notifications/test', { method: 'POST' }).catch((x): { results: { channel: string; status: string; error?: string }[] } => ({ results: [{ channel: '-', status: errText(x) }] }));
    setMsg(r.results.map((x) => `${x.channel}: ${x.status}${x.error ? ` (${x.error})` : ''}`).join(' · '));
    notifs.reload();
  }
  return (
    <>
      <h2>{t('title')}</h2>
      <div className="row">
        <select value={pid} onChange={(e) => setProjectId(e.target.value)}>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!pid} onClick={() => create('daily', false)}>
          {t('buildDaily')}
        </button>
        <button disabled={!pid} onClick={() => create('daily', true)}>
          {t('buildSendDaily')}
        </button>
        <button disabled={!pid} onClick={() => create('weekly', false)}>
          {t('buildWeekly')}
        </button>
        <button onClick={test}>{t('sendTest')}</button>
        <span className="muted small">{t('channels', { list: notifs.data?.channels.join(', ') || t('noChannels') })}</span>
      </div>
      {msg && <p className="small">{msg}</p>}
      <ErrorBox error={list.error ?? notifs.error} />
      <div className="grid2">
        <section>
          <table>
            <thead>
              <tr>
                <th>{t('thCreated')}</th>
                <th>{t('thKind')}</th>
                <th>{t('thStatus')}</th>
                <th>{t('thPeriod')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((r) => (
                <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: 'pointer', fontWeight: r.id === selected ? 600 : undefined }}>
                  <td className="small">{fmtTime(r.createdAt)}</td>
                  <td>{r.kind}</td>
                  <td>
                    <Status s={r.status} />
                  </td>
                  <td className="small">
                    {fmtTime(r.periodStart)} → {fmtTime(r.periodEnd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.data?.items.length === 0 && <Empty>{t('noReports')}</Empty>}
        </section>
        <section>
          {one.data ? (
            <>
              <pre className="tile" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
                {one.data.markdown}
              </pre>
              {one.data.exportDownloadUrl && <a href={one.data.exportDownloadUrl}>{t('downloadExcel')}</a>}
            </>
          ) : (
            <Empty>{t('selectReport')}</Empty>
          )}
        </section>
      </div>
      <h3>{t('notifLog')}</h3>
      <table>
        <thead>
          <tr>
            <th>{t('thCreated')}</th>
            <th>{t('thChannel')}</th>
            <th>{t('thType')}</th>
            <th>{t('thStatus')}</th>
            <th>{t('thTitleError')}</th>
          </tr>
        </thead>
        <tbody>
          {notifs.data?.items.map((n) => (
            <tr key={n.id}>
              <td className="small">{fmtTime(n.createdAt)}</td>
              <td>{n.channel}</td>
              <td>{n.type}</td>
              <td>
                <Status s={n.status} /> <span className="muted small">×{n.attempts}</span>
              </td>
              <td className="small">
                {n.title}
                {n.error && <div className="error-inline">{n.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
