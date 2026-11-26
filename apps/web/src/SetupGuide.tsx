import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { currentLocale, defineMessages, useT, type TFn } from './i18n.tsx';
import { useLoad } from './ui.tsx';

/*
 * Setup guide dialog: a live checklist built from GET /setup/status (booleans and counts only, never secrets).
 * Opens once on the first visit and from the sidebar. Settings live in `.env`; after editing it, restart the app.
 */

export interface SetupStatus {
  checkedAt: string;
  app: { database: boolean; queueDriver: 'bullmq' | 'inline'; schedulerPaused: boolean };
  sources: {
    bluesky: { enabled: boolean; status: string | null; appPasswordSet: boolean; policyProposal: string | null };
    youtube: { enabled: boolean; status: string | null; apiKeySet: boolean };
    appleAppStore: { policyProposal: string | null };
  };
  features: {
    ai: { anthropicKeySet: boolean };
    notifications: { telegram: boolean; email: boolean; webhook: boolean };
    backup: { passphraseSet: boolean; keyFileExists: boolean; backups: number };
    remoteAccess: { loopbackOnly: boolean; apiTokenSet: boolean };
  };
  data: { projects: number; trackedAccounts: number; activeKeywords: number; posts: number; apps: number; workflows: number };
}

const SEEN_KEY = 'sss-setup-guide-seen';
export function guideSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}
export function markGuideSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/** Core steps counted in the sidebar progress. */
function coreSteps(s: SetupStatus) {
  return [true, s.data.projects > 0, s.data.trackedAccounts > 0, s.sources.youtube.apiKeySet];
}

export function useSetupStatus() {
  const r = useLoad(() => api<SetupStatus>('/setup/status'), []);
  const core = r.data ? coreSteps(r.data) : [];
  return { ...r, done: core.filter(Boolean).length, total: core.length || 4 };
}

function Snippet({ text, copy = 'Copy', copiedLabel = 'Copied' }: { text: string; copy?: string; copiedLabel?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <pre>{text}</pre>
      <button
        onClick={() =>
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          )
        }
      >
        {copied ? copiedLabel : copy}
      </button>
    </div>
  );
}

type Kind = 'done' | 'todo' | 'optional' | 'decision';
function Step({ kind, title, badge, children }: { kind: Kind; title: string; badge?: ReactNode; children?: ReactNode }) {
  const icon = kind === 'done' ? '✓' : kind === 'decision' ? '!' : kind === 'todo' ? '•' : '+';
  return (
    <div className={`step${kind === 'done' ? ' done' : ''}`}>
      <span className={`step-icon ${kind}`} aria-label={kind}>
        {icon}
      </span>
      <div>
        <div className="step-title">
          {title} {badge}
        </div>
        {children}
      </div>
    </div>
  );
}

/** Renders `code` and **bold** markers inside translated text (no HTML from messages). */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part,
      )}
    </>
  );
}

const M = defineMessages({
  title: ['Setup guide', 'Hướng dẫn cài đặt'],
  progress: ['{done} of {total} core steps done.', 'Đã xong {done}/{total} bước chính.'],
  checking: ['Checking this installation…', 'Đang kiểm tra bản cài đặt…'],
  intro: [
    'Settings live in the `.env` file in the app folder (copy `.env.example` to `.env` if it is missing). After editing it, restart the app with `stop.bat` then `start.bat`, and press **Re-check**.',
    'Cấu hình nằm trong file `.env` ở thư mục ứng dụng (nếu chưa có, sao chép `.env.example` thành `.env`). Sau khi sửa, khởi động lại bằng `stop.bat` rồi `start.bat`, sau đó bấm **Kiểm tra lại**.',
  ],
  close: ['Close setup guide', 'Đóng hướng dẫn'],
  copy: ['Copy', 'Sao chép'],
  copied: ['Copied', 'Đã chép'],
  configured: ['Configured', 'Đã cấu hình'],
  notSet: ['Not set', 'Chưa cấu hình'],
  groupStart: ['Get started', 'Bắt đầu'],
  groupSources: ['Data sources', 'Nguồn dữ liệu'],
  groupOptional: ['Optional features', 'Tính năng tùy chọn'],
  groupDecisions: ['Decisions waiting for you', 'Các quyết định đang chờ bạn'],
  running: ['The app is running', 'Ứng dụng đang chạy'],
  singleMode: ['Single-process mode', 'Chế độ một tiến trình'],
  workerMode: ['Worker + scheduler mode', 'Chế độ worker + scheduler'],
  dbReady: ['Database ready.', 'Cơ sở dữ liệu sẵn sàng.'],
  inlineNote: ['Jobs and schedules run inside the app (no Redis needed on one computer).', 'Tác vụ và lịch chạy hoạt động ngay trong ứng dụng (một máy thì không cần Redis).'],
  workerNote: ['Jobs run in the background worker.', 'Tác vụ chạy trong worker nền.'],
  paused: [' Schedules are paused: resume them on the Schedules page.', ' Lịch chạy đang tạm dừng: bật lại ở trang Lịch chạy.'],
  projectTitle: ['Create your first project', 'Tạo dự án đầu tiên'],
  projectActive: ['{n} active', '{n} đang hoạt động'],
  projectText: ['A project groups the market you watch: its platforms, languages, keywords and competitors.', 'Một dự án gom thị trường bạn theo dõi: nền tảng, ngôn ngữ, từ khóa và đối thủ.'],
  openProjects: ['Open Projects →', 'Mở Dự án →'],
  competitorsTitle: ['Add competitors', 'Thêm đối thủ'],
  tracked: ['{n} tracked', '{n} đang theo dõi'],
  discover: [
    '**Discover:** in a project, add keywords ({n} active now), run discovery, then approve the candidates you want to track.',
    '**Khám phá:** trong một dự án, thêm từ khóa (hiện có {n} từ khóa đang bật), chạy khám phá rồi duyệt các ứng viên muốn theo dõi.',
  ],
  direct: [
    '**Or add directly:** on Accounts, paste a profile URL or handle (for example `https://bsky.app/profile/name.bsky.social`).',
    '**Hoặc thêm trực tiếp:** ở trang Tài khoản, dán link hồ sơ hoặc handle (ví dụ `https://bsky.app/profile/name.bsky.social`).',
  ],
  keywordsLink: ['Keywords & discovery →', 'Từ khóa & khám phá →'],
  trackLink: ['Track an account →', 'Theo dõi tài khoản →'],
  blueskyWorking: ['Working, no key needed', 'Đang hoạt động, không cần key'],
  disabled: ['Disabled', 'Đang tắt'],
  blueskyText: ['Public profiles, posts and search work without an account.', 'Hồ sơ công khai, bài đăng và tìm kiếm hoạt động mà không cần tài khoản.'],
  ytTitle: ['YouTube API key', 'API key YouTube'],
  ytEnabled: ['Enabled', 'Đã bật'],
  ytPending: ['Key set: verification pending', 'Đã có key: chờ xác minh'],
  ytText: ["The second data source. It is free within Google's daily quota.", 'Nguồn dữ liệu thứ hai, miễn phí trong hạn mức hằng ngày của Google.'],
  ytOpen: ['Open', 'Mở'],
  ytConsole: ['Google Cloud Console → YouTube Data API v3', 'Google Cloud Console → YouTube Data API v3'],
  ytStep1: [', create or select a project, then press **Enable**.', ', tạo hoặc chọn một project rồi bấm **Enable**.'],
  ytStep2: [
    'Go to **APIs & Services → Credentials → Create credentials → API key**. Restrict the key to YouTube Data API v3.',
    'Vào **APIs & Services → Credentials → Create credentials → API key**. Giới hạn key chỉ cho YouTube Data API v3.',
  ],
  ytStep3: ['Add it to `.env`, then restart:', 'Thêm vào `.env` rồi khởi động lại:'],
  ytNote: ['YouTube switches on after 3 verification runs (`npm run poc -- youtube`), as recorded in ADR-0007.', 'YouTube được bật sau 3 lần chạy xác minh (`npm run poc -- youtube`), theo ADR-0007.'],
  bskyPwTitle: ['Bluesky App Password (optional)', 'Mật khẩu ứng dụng Bluesky (tùy chọn)'],
  bskyPwText: [
    'Lets keyword search go past the first page of results. In the Bluesky app: **Settings → Privacy and security → App passwords → Add**. Use an App Password, never your main password.',
    'Cho phép tìm theo từ khóa vượt quá trang kết quả đầu tiên. Trong ứng dụng Bluesky: **Settings → Privacy and security → App passwords → Add**. Hãy dùng App Password, không bao giờ dùng mật khẩu chính.',
  ],
  aiTitle: ['AI analysis (Claude)', 'Phân tích AI (Claude)'],
  aiText: ['Summarises top posts on the Insights page. Create a key at', 'Tóm tắt các bài đăng nổi bật ở trang Phân tích. Tạo key tại'],
  aiLink: ['console.anthropic.com → API keys', 'console.anthropic.com → API keys'],
  reportsTitle: ['Reports by Telegram, email or webhook', 'Gửi báo cáo qua Telegram, email hoặc webhook'],
  tgOn: ['Telegram on', 'Telegram bật'],
  tgOff: ['Telegram off', 'Telegram tắt'],
  emailOn: ['Email on', 'Email bật'],
  emailOff: ['Email off', 'Email tắt'],
  hookOn: ['Webhook on', 'Webhook bật'],
  hookOff: ['Webhook off', 'Webhook tắt'],
  tgHow: [
    '**Telegram:** create a bot with `@BotFather` to get its token. Send the bot a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.',
    '**Telegram:** tạo bot với `@BotFather` để lấy token. Nhắn cho bot một tin, rồi mở `https://api.telegram.org/bot<TOKEN>/getUpdates` và sao chép `chat.id`.',
  ],
  emailHow: ['**Email:** an SMTP account (for example a Gmail app password).', '**Email:** một tài khoản SMTP (ví dụ mật khẩu ứng dụng của Gmail).'],
  hookHow: ['**Webhook:** any URL (for example n8n). Payloads are signed with the secret.', '**Webhook:** một URL bất kỳ (ví dụ n8n). Dữ liệu gửi đi được ký bằng secret.'],
  testLink: ['Send a test notification on Reports →', 'Gửi thông báo thử ở trang Báo cáo →'],
  backupTitle: ['Keep the backup key safe', 'Cất giữ key sao lưu an toàn'],
  backups: ['{n} backup(s)', '{n} bản sao lưu'],
  backupIntro: ['Backups run daily and are encrypted.', 'Sao lưu chạy hằng ngày và được mã hóa.'],
  backupPass: ['A passphrase is set: keep it somewhere safe.', 'Đã đặt passphrase: hãy cất nó ở nơi an toàn.'],
  backupKey: [
    'The key is in `.data/backup.key`. Copy it somewhere safe (a password manager or a USB stick), or the backups cannot be restored.',
    'Key nằm ở `.data/backup.key`. Hãy sao chép nó ra nơi an toàn (trình quản lý mật khẩu hoặc USB), nếu không sẽ không khôi phục được bản sao lưu.',
  ],
  backupNone: ['A key is created at the first backup; or set a passphrase now:', 'Key được tạo ở lần sao lưu đầu tiên; hoặc đặt passphrase ngay:'],
  redisTitle: ['Background worker (Redis)', 'Worker nền (Redis)'],
  redisOn: ['Running', 'Đang chạy'],
  redisOff: ['Not installed', 'Chưa cài'],
  redisText: [
    'Not needed on one computer. With Redis, jobs run in a separate worker and survive restarts better. On Windows:',
    'Không cần nếu chỉ dùng một máy. Có Redis thì tác vụ chạy ở worker riêng và an toàn hơn khi khởi động lại. Trên Windows:',
  ],
  remoteTitle: ['Access from other devices', 'Truy cập từ thiết bị khác'],
  remoteLocal: ['This computer only (safe)', 'Chỉ máy này (an toàn)'],
  remoteToken: ['Remote, token set', 'Từ xa, đã có token'],
  remote: ['Remote', 'Từ xa'],
  remoteText: [
    'The app only listens on this computer. To open it to a network, set a long `API_TOKEN` and put HTTPS in front (see `docs/DEPLOYMENT.md` §3).',
    'Ứng dụng chỉ mở trên máy này. Muốn mở ra mạng, hãy đặt `API_TOKEN` dài và dùng HTTPS phía trước (xem `docs/DEPLOYMENT.md` §3).',
  ],
  bskyPolicyTitle: ['Bluesky data policy', 'Chính sách dữ liệu Bluesky'],
  bskyPolicyText: [
    'Until it is approved, history, viral and trend analytics, AI and exports of Bluesky data stay off. To approve, set `policyProposal.status` to `"APPROVED"` in `docs/feasibility/capabilities/bluesky.json` and restart.',
    'Khi chưa duyệt, lịch sử, phân tích lan truyền/xu hướng, AI và xuất dữ liệu Bluesky vẫn tắt. Để duyệt, đặt `policyProposal.status` thành `"APPROVED"` trong `docs/feasibility/capabilities/bluesky.json` rồi khởi động lại.',
  ],
  applePolicyTitle: ['App Store data policy', 'Chính sách dữ liệu App Store'],
  applePolicyText: [
    'Approving allows daily rating and version history (365 days) and internal export in App Spy. Edit `docs/feasibility/app-stores/apple.json`.',
    'Duyệt sẽ cho phép lưu lịch sử đánh giá và phiên bản hằng ngày (365 ngày) và xuất dữ liệu nội bộ trong App Spy. Sửa `docs/feasibility/app-stores/apple.json`.',
  ],
  adTitle: ['Ad Spy sources', 'Nguồn dữ liệu Ad Spy'],
  adText: [
    'Meta needs a developer app and identity confirmation (EU and political ads only). Google needs a Google Cloud project (BigQuery). TikTok needs legal advice first. Details: `docs/feasibility/ad-spy.md`.',
    'Meta cần ứng dụng developer và xác minh danh tính (chỉ quảng cáo ở EU và quảng cáo chính trị). Google cần một project Google Cloud (BigQuery). TikTok cần tư vấn pháp lý trước. Chi tiết: `docs/feasibility/ad-spy.md`.',
  ],
  checkedAt: ['Checked {time}', 'Kiểm tra lúc {time}'],
  recheck: ['Re-check', 'Kiểm tra lại'],
  done: ['Done', 'Xong'],
  continue: ['Continue to the app', 'Vào ứng dụng'],
});

const yes = (t: TFn<keyof typeof M>, on: boolean, onText?: string, offText?: string) => (
  <span className={`badge badge-${on ? 'ok' : 'skipped'}`}>{on ? (onText ?? t('configured')) : (offText ?? t('notSet'))}</span>
);

export function SetupGuide({ status: s, error, onClose, onRecheck }: { status: SetupStatus | null; error: string | null; onClose: () => void; onRecheck: () => void }) {
  const t = useT(M);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Once per opening: focus the dialog, close on Escape, lock page scroll.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, []);
  const go = (hash: string) => () => {
    onClose();
    location.hash = hash;
  };
  const core = s ? coreSteps(s) : [];
  const done = core.filter(Boolean).length;
  const n = s?.features.notifications;
  const snip = (text: string) => <Snippet text={text} copy={t('copy')} copiedLabel={t('copied')} />;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-head">
          <span className="brand-mark" aria-hidden="true" style={{ width: 38, height: 38, fontSize: 18 }}>
            ◎
          </span>
          <div style={{ flex: 1 }}>
            <h2 id="setup-title">{t('title')}</h2>
            <p>
              {s ? t('progress', { done, total: core.length }) : t('checking')} <Rich text={t('intro')} />
            </p>
            {s && (
              <div className="progress" style={{ maxWidth: 320 }}>
                <i style={{ width: `${(100 * done) / core.length}%` }} />
              </div>
            )}
          </div>
          <button className="ghost" onClick={onClose} aria-label={t('close')}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error">{error}</div>}
          {s && (
            <>
              <div className="guide-group">{t('groupStart')}</div>
              <Step kind="done" title={t('running')} badge={<span className="badge badge-ok">{s.app.queueDriver === 'inline' ? t('singleMode') : t('workerMode')}</span>}>
                <p>
                  {t('dbReady')} {s.app.queueDriver === 'inline' ? t('inlineNote') : t('workerNote')}
                  {s.app.schedulerPaused && t('paused')}
                </p>
              </Step>
              <Step kind={s.data.projects > 0 ? 'done' : 'todo'} title={t('projectTitle')} badge={s.data.projects > 0 ? <span className="badge badge-ok">{t('projectActive', { n: s.data.projects })}</span> : undefined}>
                <p>{t('projectText')}</p>
                <div className="step-actions">
                  <a href="#/projects" onClick={go('#/projects')}>
                    {t('openProjects')}
                  </a>
                </div>
              </Step>
              <Step kind={s.data.trackedAccounts > 0 ? 'done' : 'todo'} title={t('competitorsTitle')} badge={s.data.trackedAccounts > 0 ? <span className="badge badge-ok">{t('tracked', { n: s.data.trackedAccounts })}</span> : undefined}>
                <ol>
                  <li>
                    <Rich text={t('discover', { n: s.data.activeKeywords })} />
                  </li>
                  <li>
                    <Rich text={t('direct')} />
                  </li>
                </ol>
                <div className="step-actions">
                  <a href="#/projects" onClick={go('#/projects')}>
                    {t('keywordsLink')}
                  </a>
                  <a href="#/accounts" onClick={go('#/accounts')}>
                    {t('trackLink')}
                  </a>
                </div>
              </Step>

              <div className="guide-group">{t('groupSources')}</div>
              <Step kind="done" title="Bluesky" badge={<span className="badge badge-verified">{s.sources.bluesky.enabled ? t('blueskyWorking') : t('disabled')}</span>}>
                <p>{t('blueskyText')}</p>
              </Step>
              <Step kind={s.sources.youtube.apiKeySet ? 'done' : 'todo'} title={t('ytTitle')} badge={yes(t, s.sources.youtube.apiKeySet, s.sources.youtube.enabled ? t('ytEnabled') : t('ytPending'))}>
                <p>{t('ytText')}</p>
                <ol>
                  <li>
                    {t('ytOpen')}{' '}
                    <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer">
                      {t('ytConsole')}
                    </a>
                    <Rich text={t('ytStep1')} />
                  </li>
                  <li>
                    <Rich text={t('ytStep2')} />
                  </li>
                  <li>
                    <Rich text={t('ytStep3')} />
                  </li>
                </ol>
                {snip('YOUTUBE_API_KEY=paste-your-key-here')}
                <p className="small muted">
                  <Rich text={t('ytNote')} />
                </p>
              </Step>
              <Step kind={s.sources.bluesky.appPasswordSet ? 'done' : 'optional'} title={t('bskyPwTitle')} badge={yes(t, s.sources.bluesky.appPasswordSet)}>
                <p>
                  <Rich text={t('bskyPwText')} />
                </p>
                {snip('BLUESKY_IDENTIFIER=yourname.bsky.social\nBLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx')}
              </Step>

              <div className="guide-group">{t('groupOptional')}</div>
              <Step kind={s.features.ai.anthropicKeySet ? 'done' : 'optional'} title={t('aiTitle')} badge={yes(t, s.features.ai.anthropicKeySet)}>
                <p>
                  {t('aiText')}{' '}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
                    {t('aiLink')}
                  </a>
                  .
                </p>
                {snip('ANTHROPIC_API_KEY=sk-ant-...')}
              </Step>
              <Step
                kind={n && (n.telegram || n.email || n.webhook) ? 'done' : 'optional'}
                title={t('reportsTitle')}
                badge={
                  <>
                    {yes(t, !!n?.telegram, t('tgOn'), t('tgOff'))} {yes(t, !!n?.email, t('emailOn'), t('emailOff'))} {yes(t, !!n?.webhook, t('hookOn'), t('hookOff'))}
                  </>
                }
              >
                <ol>
                  <li>
                    <Rich text={t('tgHow')} />
                  </li>
                  <li>
                    <Rich text={t('emailHow')} />
                  </li>
                  <li>
                    <Rich text={t('hookHow')} />
                  </li>
                </ol>
                {snip(
                  'TELEGRAM_BOT_TOKEN=123456:ABC...\nTELEGRAM_CHAT_ID=123456789\n# SMTP_URL=smtps://user:app-password@smtp.gmail.com:465\n# EMAIL_FROM=you@example.com\n# EMAIL_TO=you@example.com\n# WEBHOOK_URL=https://example.com/hook\n# WEBHOOK_SECRET=at-least-16-characters',
                )}
                <div className="step-actions">
                  <a href="#/reports" onClick={go('#/reports')}>
                    {t('testLink')}
                  </a>
                </div>
              </Step>
              <Step kind={s.features.backup.passphraseSet ? 'done' : 'optional'} title={t('backupTitle')} badge={<span className="badge badge-skipped">{t('backups', { n: s.features.backup.backups })}</span>}>
                <p>
                  {t('backupIntro')} {s.features.backup.passphraseSet ? t('backupPass') : s.features.backup.keyFileExists ? <Rich text={t('backupKey')} /> : t('backupNone')}
                </p>
                {!s.features.backup.passphraseSet && snip('BACKUP_PASSPHRASE=a-long-passphrase-you-will-remember')}
              </Step>
              <Step kind={s.app.queueDriver === 'bullmq' ? 'done' : 'optional'} title={t('redisTitle')} badge={yes(t, s.app.queueDriver === 'bullmq', t('redisOn'), t('redisOff'))}>
                <p>{t('redisText')}</p>
                {snip('winget install Memurai.MemuraiDeveloper')}
              </Step>
              <Step
                kind="optional"
                title={t('remoteTitle')}
                badge={<span className="badge badge-ok">{s.features.remoteAccess.loopbackOnly ? t('remoteLocal') : s.features.remoteAccess.apiTokenSet ? t('remoteToken') : t('remote')}</span>}
              >
                <p>
                  <Rich text={t('remoteText')} />
                </p>
              </Step>

              <div className="guide-group">{t('groupDecisions')}</div>
              <Step kind={s.sources.bluesky.policyProposal === 'APPROVED' ? 'done' : 'decision'} title={t('bskyPolicyTitle')} badge={<span className="badge badge-pending">{s.sources.bluesky.policyProposal ?? 'unknown'}</span>}>
                <p>
                  <Rich text={t('bskyPolicyText')} />
                </p>
              </Step>
              <Step
                kind={s.sources.appleAppStore.policyProposal === 'APPROVED' ? 'done' : 'decision'}
                title={t('applePolicyTitle')}
                badge={<span className="badge badge-pending">{s.sources.appleAppStore.policyProposal ?? 'unknown'}</span>}
              >
                <p>
                  <Rich text={t('applePolicyText')} />
                </p>
              </Step>
              <Step kind="decision" title={t('adTitle')}>
                <p>
                  <Rich text={t('adText')} />
                </p>
              </Step>
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="muted small">{s ? t('checkedAt', { time: new Date(s.checkedAt).toLocaleTimeString(currentLocale()) }) : ''}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onRecheck}>{t('recheck')}</button>
          <button className="primary" onClick={onClose}>
            {s && done === core.length ? t('done') : t('continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
