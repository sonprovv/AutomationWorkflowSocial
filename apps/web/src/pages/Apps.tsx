import { useState } from 'react';
import { api, type Page, type Project } from '../api.ts';
import { currentLocale, defineMessages, useT } from '../i18n.tsx';
import { Empty, errText, ErrorBox, ExternalLink, fmtNum, fmtTime, Loading, Status, useLoad } from '../ui.tsx';

/*
 * App Spy (Phase 9, P9-03, ADR-0018): Apple App Store listings via the official iTunes Search API, and
 * app → developer website → social profile links with evidence. No icons or screenshots (Apple promo-content
 * rule); every app links to its App Store page; Google Play is BLOCKED (no official API).
 */

const M = defineMessages({
  free: ['Free', 'Miễn phí'],
  polSource: [
    'Source: Apple iTunes Search API (official, public; about 20 calls per minute), checked {at}. Policy',
    'Nguồn: Apple iTunes Search API (chính thức, công khai; khoảng 20 lượt gọi mỗi phút), kiểm tra lúc {at}. Chính sách',
  ],
  polKept: [': only the latest listing of tracked apps is kept', ': chỉ lưu thông tin mới nhất của các ứng dụng đang theo dõi'],
  polNoHistory: [' (no history)', ' (không lưu lịch sử)'],
  polNoExport: [', no export', ', không xuất dữ liệu'],
  polNoMedia: [', no icons or screenshots. ', ', không lưu biểu tượng hay ảnh chụp màn hình. '],
  polPending: [
    'History and export wait for the Product Owner to approve the policy proposal.',
    'Lịch sử và xuất dữ liệu đang chờ Product Owner duyệt đề xuất chính sách.',
  ],
  polTail: [
    ' Google Play: BLOCKED (no official API). Downloads, revenue and rankings are not available and are never estimated.',
    ' Google Play: BLOCKED (không có API chính thức). Lượt tải, doanh thu và thứ hạng không có sẵn và không bao giờ được ước tính.',
  ],
  searchStore: ['Search the App Store', 'Tìm kiếm trên App Store'],
  searchPlaceholder: ['note taking', 'ghi chú'],
  storefront: ['Storefront', 'Cửa hàng (quốc gia)'],
  search: ['Search', 'Tìm kiếm'],
  trackBy: ['Or track by App Store link, id or bundle id', 'Hoặc theo dõi bằng liên kết App Store, id hoặc bundle id'],
  addToProject: ['Add to project', 'Thêm vào dự án'],
  noneOption: ['— none —', '— không —'],
  trackApp: ['Track app', 'Theo dõi ứng dụng'],
  searchResults: ['Search results', 'Kết quả tìm kiếm'],
  noAppsFound: ['No apps found.', 'Không tìm thấy ứng dụng nào.'],
  trackedApps: ['Tracked apps', 'Ứng dụng đang theo dõi'],
  trackedAppsInProject: ['Tracked apps in this project', 'Ứng dụng đang theo dõi trong dự án này'],
  noTrackedApps: ['No tracked apps yet.', 'Chưa theo dõi ứng dụng nào.'],
  colApp: ['App', 'Ứng dụng'],
  colDeveloper: ['Developer', 'Nhà phát triển'],
  colStore: ['Store', 'Cửa hàng'],
  colRating: ['Rating', 'Đánh giá'],
  colVersion: ['Version', 'Phiên bản'],
  colSocialLinks: ['Social links', 'Liên kết mạng xã hội'],
  colCollected: ['Collected', 'Thu thập lúc'],
  colPrice: ['Price', 'Giá'],
  colRatingCount: ['Rating (count)', 'Đánh giá (số lượt)'],
  colUpdated: ['Updated', 'Cập nhật'],
  colWebsite: ['Website', 'Website'],
  noWebsiteTitle: ['The developer lists no website', 'Nhà phát triển không ghi website'],
  trackedArrow: ['Tracked →', 'Đang theo dõi →'],
  track: ['Track', 'Theo dõi'],
  storefrontCountry: ['storefront {c}', 'cửa hàng {c}'],
  lastUpdate: ['Last update', 'Lần cập nhật gần nhất'],
  firstRelease: ['First release', 'Phát hành lần đầu'],
  srcLine: ['Source {provider} · collected {time} ·', 'Nguồn {provider} · thu thập lúc {time} ·'],
  storePage: ['App Store page', 'Trang App Store'],
  developerPage: ['developer page', 'trang nhà phát triển'],
  refreshListing: ['Refresh listing', 'Làm mới thông tin'],
  listingRefreshed: ['Listing refreshed.', 'Đã làm mới thông tin.'],
  developerOtherApps: ['Developer’s other apps', 'Ứng dụng khác của nhà phát triển'],
  confirmStop: ['Stop tracking this app everywhere?', 'Ngừng theo dõi ứng dụng này ở mọi nơi?'],
  stopTracking: ['Stop tracking', 'Ngừng theo dõi'],
  socialTitle: ['Social accounts (from the developer website)', 'Tài khoản mạng xã hội (từ website của nhà phát triển)'],
  evidence1: [
    'Evidence chain: App Store listing → developer website the store lists (',
    'Chuỗi bằng chứng: thông tin trên App Store → website nhà phát triển mà cửa hàng ghi (',
  ],
  noneListed: ['none listed', 'không có'],
  evidence2: [
    ') → profile links published on that page. Names are never matched. HIGH = the page stayed on the listed site; MEDIUM = it redirected to another site. Confirm or reject each one.',
    ') → các liên kết hồ sơ được đăng trên trang đó. Không bao giờ ghép theo tên. HIGH = trang vẫn ở trên website đã ghi; MEDIUM = trang chuyển hướng sang website khác. Hãy xác nhận hoặc từ chối từng liên kết.',
  ],
  noWebsiteListing: ['The listing has no developer website', 'Thông tin ứng dụng không có website nhà phát triển'],
  discoverResult: [
    'Checked {url}: {found} profile link(s), {created} new, {matched} match an account you track.',
    'Đã kiểm tra {url}: {found} liên kết hồ sơ, {created} mới, {matched} khớp với tài khoản bạn đang theo dõi.',
  ],
  checkWebsite: ['Check developer website', 'Kiểm tra website nhà phát triển'],
  noLinksYet: ['No links checked yet.', 'Chưa kiểm tra liên kết nào.'],
  noWebsiteEmpty: [
    'This listing has no developer website, so no account can be linked with evidence.',
    'Ứng dụng này không có website nhà phát triển, nên không thể liên kết tài khoản nào kèm bằng chứng.',
  ],
  colProfile: ['Profile', 'Hồ sơ'],
  colConfidence: ['Confidence', 'Độ tin cậy'],
  colEvidence: ['Evidence', 'Bằng chứng'],
  colTrackedAccount: ['Tracked account', 'Tài khoản đang theo dõi'],
  colStatus: ['Status', 'Trạng thái'],
  evLink: ['link', 'liên kết'],
  evOn: ['on', 'trên'],
  redirectedFrom: [' (redirected from {host})', ' (chuyển hướng từ {host})'],
  checkedTime: ['checked {time}', 'kiểm tra lúc {time}'],
  notTracked: ['not tracked', 'chưa theo dõi'],
  confirm: ['Confirm', 'Xác nhận'],
  reject: ['Reject', 'Từ chối'],
  otherAppsBy: ['Other apps by {name}', 'Ứng dụng khác của {name}'],
  none: ['None.', 'Không có.'],
  trackingApp: ['Tracking {name}.', 'Đang theo dõi {name}.'],
  storeDescription: ['Store description', 'Mô tả trên cửa hàng'],
});

interface StoreApp {
  storeAppId: string;
  country: string;
  bundleId: string | null;
  name: string;
  developerId: string | null;
  developerName: string | null;
  websiteUrl: string | null;
  storeUrl: string;
  genre: string | null;
  price: number | null;
  currency: string | null;
  rating: number | null;
  ratingCount: number | null;
  version: string | null;
  storeUpdatedAt: string | null;
  missing?: Record<string, string>;
  trackedId?: string | null;
}
interface TrackedApp extends StoreApp {
  id: string;
  sellerName: string | null;
  developerUrl: string | null;
  releasedAt: string | null;
  description: string | null;
  details: { genres?: string[]; contentRating?: string | null; languages?: string[]; minimumOsVersion?: string | null; missing?: Record<string, string> };
  status: string;
  provenance: { providerId: string; policyId: string; collectedAt: string };
  projectIds: string[];
  linkCount?: number;
}
interface AppLink {
  id: string;
  platform: string;
  handle: string;
  profileUrl: string;
  method: string;
  confidence: string;
  status: string;
  evidence: { websiteUrl: string; finalUrl: string; redirects: string[]; sameSite: boolean; href: string; fetchedAt: string; storeUrl: string };
  account: { id: string; platform: string; username: string | null; displayName: string | null; profileUrl: string } | null;
  decidedAt: string | null;
}
interface AppDetail extends TrackedApp {
  links: AppLink[];
  policy: Policy;
}
interface Policy {
  status: string;
  checkedAt: string;
  policyId: string;
  storeMetadata: boolean;
  historicalSnapshots: boolean;
  export: boolean;
  proposalStatus: string | null;
  limitations: string[];
}

const COUNTRIES = ['us', 'vn', 'gb', 'jp', 'kr', 'de', 'fr', 'in', 'br', 'au', 'ca', 'sg', 'th', 'id'];
const rating = (a: StoreApp) =>
  a.rating === null ? (
    fmtNum(null, a.missing?.rating)
  ) : (
    <>
      {a.rating.toFixed(2)} <span className="muted small">({fmtNum(a.ratingCount)})</span>
    </>
  );
const price = (a: StoreApp, free: string) => (a.price === null ? fmtNum(null) : a.price === 0 ? free : `${a.price} ${a.currency ?? ''}`);
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString(currentLocale()) : '—');

function PolicyNotice({ p }: { p: Policy | null }) {
  const t = useT(M);
  if (!p) return null;
  return (
    <div className="notice small">
      {t('polSource', { at: p.checkedAt })} <code>{p.policyId}</code>
      {t('polKept')}
      {p.historicalSnapshots ? '' : t('polNoHistory')}
      {p.export ? '' : t('polNoExport')}
      {t('polNoMedia')}
      {p.proposalStatus === 'PENDING_PRODUCT_OWNER_APPROVAL' && t('polPending')}
      {t('polTail')}
    </div>
  );
}

/* ---------------- list + search ---------------- */
export function Apps() {
  const t = useT(M);
  const policy = useLoad(() => api<Policy>('/apps/policy'), []);
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [projectId, setProjectId] = useState('');
  const tracked = useLoad(() => api<{ items: TrackedApp[] }>(`/apps${projectId ? `?projectId=${projectId}` : ''}`), [projectId]);
  const [term, setTerm] = useState('');
  const [country, setCountry] = useState('us');
  const [results, setResults] = useState<{ items: StoreApp[]; note: string } | null>(null);
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    setErr(null);
    try {
      setResults(await api(`/apps/search?term=${encodeURIComponent(term.trim())}&country=${country}`));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function track(value: string, c?: string) {
    setBusy(true);
    setErr(null);
    try {
      const a = await api<TrackedApp>('/apps', { method: 'POST', body: { input: value, ...(c ? { country: c } : {}), ...(projectId ? { projectId } : {}) } });
      location.hash = `#/app/${a.id}`;
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <>
      <h2>App Spy</h2>
      <PolicyNotice p={policy.data} />
      <div className="filters">
        <label>
          {t('searchStore')}
          <input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && term.trim() && search()} placeholder={t('searchPlaceholder')} />
        </label>
        <label>
          {t('storefront')}
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={!term.trim() || busy} onClick={search}>
          {t('search')}
        </button>
        <span style={{ width: 24 }} />
        <label>
          {t('trackBy')}
          <input className="narrow" style={{ width: 320 }} value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://apps.apple.com/us/app/…/id123456789" />
        </label>
        <label>
          {t('addToProject')}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t('noneOption')}</option>
            {projects.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={!input.trim() || busy} onClick={() => track(input)}>
          {t('trackApp')}
        </button>
      </div>
      <ErrorBox error={err ?? policy.error} />
      {results && (
        <>
          <h3>{t('searchResults')}</h3>
          <p className="muted small">{results.note}</p>
          {results.items.length === 0 ? <Empty>{t('noAppsFound')}</Empty> : <AppTable items={results.items} onTrack={(a) => track(a.storeAppId, a.country)} busy={busy} />}
        </>
      )}
      <h3>{projectId ? t('trackedAppsInProject') : t('trackedApps')}</h3>
      <ErrorBox error={tracked.error} />
      <Loading on={tracked.loading} />
      {tracked.data && tracked.data.items.length === 0 && <Empty>{t('noTrackedApps')}</Empty>}
      {tracked.data && tracked.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('colApp')}</th>
              <th>{t('colDeveloper')}</th>
              <th>{t('colStore')}</th>
              <th>{t('colRating')}</th>
              <th>{t('colVersion')}</th>
              <th>{t('colSocialLinks')}</th>
              <th>{t('colCollected')}</th>
            </tr>
          </thead>
          <tbody>
            {tracked.data.items.map((a) => (
              <tr key={a.id}>
                <td>
                  <a href={`#/app/${a.id}`}>{a.name}</a> {a.status !== 'ACTIVE' && <Status s={a.status} />}
                  <div className="muted small">{a.genre}</div>
                </td>
                <td>{a.developerName ?? '—'}</td>
                <td className="small">
                  <ExternalLink href={a.storeUrl}>App Store ({a.country.toUpperCase()})</ExternalLink>
                </td>
                <td>{rating(a)}</td>
                <td>{a.version ?? '—'}</td>
                <td>{a.linkCount ?? 0}</td>
                <td className="small">{fmtTime(a.provenance.collectedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function AppTable({ items, onTrack, busy }: { items: StoreApp[]; onTrack: (a: StoreApp) => void; busy: boolean }) {
  const t = useT(M);
  return (
    <table>
      <thead>
        <tr>
          <th>{t('colApp')}</th>
          <th>{t('colDeveloper')}</th>
          <th>{t('colPrice')}</th>
          <th>{t('colRatingCount')}</th>
          <th>{t('colUpdated')}</th>
          <th>{t('colWebsite')}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={`${a.country}-${a.storeAppId}`}>
            <td>
              <ExternalLink href={a.storeUrl}>{a.name}</ExternalLink>
              <div className="muted small">
                {a.genre} · <code>{a.bundleId}</code>
              </div>
            </td>
            <td>{a.developerName ?? '—'}</td>
            <td>{price(a, t('free'))}</td>
            <td>{rating(a)}</td>
            <td className="small">{fmtDate(a.storeUpdatedAt)}</td>
            <td className="small">
              {a.websiteUrl ? (
                <ExternalLink href={a.websiteUrl}>{new URL(a.websiteUrl).hostname}</ExternalLink>
              ) : (
                <span className="muted" title={t('noWebsiteTitle')}>
                  —
                </span>
              )}
            </td>
            <td>
              {a.trackedId ? (
                <a href={`#/app/${a.trackedId}`}>{t('trackedArrow')}</a>
              ) : (
                <button disabled={busy} onClick={() => onTrack(a)}>
                  {t('track')}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- one app ---------------- */
export function AppPage({ id }: { id: string }) {
  const t = useT(M);
  const app = useLoad(() => api<AppDetail>(`/apps/${id}`), [id]);
  const [dev, setDev] = useState<{ developer: { name: string } | null; items: StoreApp[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setMsg(null);
    try {
      const text = await fn();
      if (text) setMsg({ ok: true, text });
      app.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (app.error) return <ErrorBox error={app.error} />;
  if (!app.data) return <Loading on />;
  const a = app.data;
  return (
    <>
      <p className="small">
        <a href="#/apps">← App Spy</a>
      </p>
      <h2 style={{ marginBottom: 4 }}>
        {a.name} {a.status !== 'ACTIVE' && <Status s={a.status} />}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {a.developerName} · {a.genre} · <code>{a.bundleId}</code> · {t('storefrontCountry', { c: a.country.toUpperCase() })}
      </p>
      <PolicyNotice p={a.policy} />
      <div className="stats">
        <div>
          <div className="muted small">{t('colRating')}</div>
          <b>{rating(a)}</b>
        </div>
        <div>
          <div className="muted small">{t('colPrice')}</div>
          <b>{price(a, t('free'))}</b>
        </div>
        <div>
          <div className="muted small">{t('colVersion')}</div>
          <b>{a.version ?? '—'}</b>
        </div>
        <div>
          <div className="muted small">{t('lastUpdate')}</div>
          <b>{fmtDate(a.storeUpdatedAt)}</b>
        </div>
        <div>
          <div className="muted small">{t('firstRelease')}</div>
          <b>{fmtDate(a.releasedAt)}</b>
        </div>
      </div>
      <p className="small muted">
        {t('srcLine', { provider: a.provenance.providerId, time: fmtTime(a.provenance.collectedAt) })} <ExternalLink href={a.storeUrl}>{t('storePage')}</ExternalLink>
        {a.developerUrl && (
          <>
            {' '}
            · <ExternalLink href={a.developerUrl}>{t('developerPage')}</ExternalLink>
          </>
        )}
      </p>
      <div className="row">
        <button disabled={busy} onClick={() => run(async () => (await api(`/apps/${id}/refresh`, { method: 'POST' }), t('listingRefreshed')))}>
          {t('refreshListing')}
        </button>
        <button disabled={busy || !a.developerId} onClick={() => run(async () => setDev(await api(`/apps/${id}/developer-apps`)))}>
          {t('developerOtherApps')}
        </button>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (a.projectIds.length && !window.confirm(t('confirmStop'))) return;
              await api(`/apps/${id}`, { method: 'DELETE' });
              location.hash = '#/apps';
            })
          }
        >
          {t('stopTracking')}
        </button>
      </div>
      {msg && <div className={msg.ok ? 'ok' : 'error'}>{msg.text}</div>}

      <h3>{t('socialTitle')}</h3>
      <p className="muted small">
        {t('evidence1')}
        {a.websiteUrl ? <ExternalLink href={a.websiteUrl}>{a.websiteUrl}</ExternalLink> : t('noneListed')}
        {t('evidence2')}
      </p>
      <div className="row">
        <button
          disabled={busy || !a.websiteUrl}
          title={a.websiteUrl ? '' : t('noWebsiteListing')}
          onClick={() => run(async () => {
            const r = await api<{ found: number; created: number; matchedTrackedAccounts: number; finalUrl: string }>(`/apps/${id}/discover-links`, { method: 'POST' });
            return t('discoverResult', { url: r.finalUrl, found: r.found, created: r.created, matched: r.matchedTrackedAccounts });
          })}
        >
          {t('checkWebsite')}
        </button>
      </div>
      {a.links.length === 0 ? (
        <Empty>{a.websiteUrl ? t('noLinksYet') : t('noWebsiteEmpty')}</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('colProfile')}</th>
              <th>{t('colConfidence')}</th>
              <th>{t('colEvidence')}</th>
              <th>{t('colTrackedAccount')}</th>
              <th>{t('colStatus')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {a.links.map((l) => (
              <tr key={l.id}>
                <td>
                  {l.platform} · <ExternalLink href={l.profileUrl}>{l.handle}</ExternalLink>
                </td>
                <td>
                  <span className={`badge badge-${l.confidence === 'HIGH' ? 'ok' : 'paused'}`}>{l.confidence}</span>
                </td>
                <td className="small">
                  {t('evLink')} <code>{l.evidence.href}</code> {t('evOn')} <ExternalLink href={l.evidence.finalUrl}>{new URL(l.evidence.finalUrl).hostname}</ExternalLink>
                  {l.evidence.redirects.length > 0 && t('redirectedFrom', { host: new URL(l.evidence.websiteUrl).hostname })}
                  <div className="muted">{t('checkedTime', { time: fmtTime(l.evidence.fetchedAt) })}</div>
                </td>
                <td>{l.account ? <a href={`#/account/${l.account.id}`}>{l.account.username ?? l.account.displayName}</a> : <span className="muted">{t('notTracked')}</span>}</td>
                <td>
                  <Status s={l.status} />
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {l.status !== 'CONFIRMED' && (
                    <button disabled={busy} onClick={() => run(() => api(`/app-links/${l.id}`, { method: 'PATCH', body: { status: 'CONFIRMED' } }).then(() => undefined))}>
                      {t('confirm')}
                    </button>
                  )}{' '}
                  {l.status !== 'REJECTED' && (
                    <button disabled={busy} onClick={() => run(() => api(`/app-links/${l.id}`, { method: 'PATCH', body: { status: 'REJECTED' } }).then(() => undefined))}>
                      {t('reject')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {dev && (
        <>
          <h3>{t('otherAppsBy', { name: dev.developer?.name ?? a.developerName ?? '' })}</h3>
          {dev.items.length === 0 ? (
            <Empty>{t('none')}</Empty>
          ) : (
            <AppTable items={dev.items} busy={busy} onTrack={(x) => run(async () => (await api('/apps', { method: 'POST', body: { input: x.storeAppId, country: x.country } }), t('trackingApp', { name: x.name })))} />
          )}
        </>
      )}

      {a.description && (
        <details>
          <summary>{t('storeDescription')}</summary>
          <p className="bio small">{a.description}</p>
        </details>
      )}
    </>
  );
}
