import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountPage, Accounts } from './pages/Accounts.tsx';
import { AppPage, Apps } from './pages/Apps.tsx';
import { Builder } from './pages/Builder.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Explorer } from './pages/Explorer.tsx';
import { Insights } from './pages/Insights.tsx';
import { Exports, Jobs, Sources, Workflows } from './pages/Ops.tsx';
import { ProjectPage, Projects } from './pages/Projects.tsx';
import { Reports } from './pages/Reports.tsx';
import { guideSeen, markGuideSeen, SetupGuide, useSetupStatus } from './SetupGuide.tsx';
import { Icon, type IconName } from './icons.tsx';
import { applyTheme, defineMessages, initialTheme, PrefsProvider, usePrefs, useT, type Lang, type Theme } from './i18n.tsx';
import './styles.css';

/*
 * Phase 5 web UI (Master Plan §10): Dashboard, Projects (keywords, discovery, review queue), Accounts,
 * Content Explorer with server-side filters + exports, Job Monitor, Schedules, Exports, Data Sources; Phase 9 adds
 * App Spy and the Workflow Builder. English/Vietnamese and light/dark/system theme: i18n.tsx.
 * Hash routing keeps the app a static bundle served by the API (no server-side routing needed).
 */

type Route =
  | { page: 'dashboard' }
  | { page: 'projects' }
  | { page: 'project'; id: string }
  | { page: 'accounts' }
  | { page: 'account'; id: string }
  | { page: 'explore' }
  | { page: 'insights' }
  | { page: 'jobs' }
  | { page: 'workflows' }
  | { page: 'builder'; id?: string }
  | { page: 'apps' }
  | { page: 'app'; id: string }
  | { page: 'exports' }
  | { page: 'reports' }
  | { page: 'sources' };

const SIMPLE = ['projects', 'accounts', 'explore', 'insights', 'apps', 'jobs', 'workflows', 'exports', 'reports', 'sources'] as const;

function parseHash(): Route {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, id] = (path ?? '').split('/');
  if ((page === 'account' || page === 'project' || page === 'app') && id) return { page, id };
  if (page === 'builder') return id ? { page, id } : { page };
  if ((SIMPLE as readonly string[]).includes(page ?? '')) return { page: page as (typeof SIMPLE)[number] };
  return { page: 'dashboard' };
}

const M = defineMessages({
  overview: ['Overview', 'Chung'],
  research: ['Research', 'Nghiên cứu'],
  automation: ['Automation', 'Tự động hóa'],
  output: ['Output', 'Kết quả'],
  system: ['System', 'Hệ thống'],
  dashboard: ['Dashboard', 'Tổng quan'],
  projects: ['Projects', 'Dự án'],
  accounts: ['Accounts', 'Tài khoản'],
  explore: ['Content Explorer', 'Khám phá nội dung'],
  insights: ['Insights', 'Phân tích'],
  apps: ['App Spy', 'App Spy'],
  builder: ['Workflow Builder', 'Trình tạo quy trình'],
  workflows: ['Schedules', 'Lịch chạy'],
  jobs: ['Job Monitor', 'Giám sát tác vụ'],
  exports: ['Exports', 'Xuất dữ liệu'],
  reports: ['Reports', 'Báo cáo'],
  sources: ['Data Sources', 'Nguồn dữ liệu'],
  apiDocs: ['API docs', 'Tài liệu API'],
  tagline: ['Competitor intelligence', 'Theo dõi đối thủ'],
  setupGuide: ['Setup guide', 'Hướng dẫn cài đặt'],
  setupDone: ['Core setup complete', 'Đã xong các bước chính'],
  setupTodo: ['Finish setting up', 'Hoàn tất cài đặt'],
  setupHint: ['Keys, sources, reports', 'Key, nguồn dữ liệu, báo cáo'],
  language: ['Language', 'Ngôn ngữ'],
  theme: ['Theme', 'Giao diện'],
  themeSystem: ['Follow the system theme', 'Theo hệ thống'],
  themeLight: ['Light', 'Sáng'],
  themeDark: ['Dark', 'Tối'],
  nav: ['Main navigation', 'Điều hướng chính'],
});
type NavKey = 'dashboard' | 'projects' | 'accounts' | 'explore' | 'insights' | 'apps' | 'builder' | 'workflows' | 'jobs' | 'exports' | 'reports' | 'sources';

const NAV: { group: 'overview' | 'research' | 'automation' | 'output' | 'system'; items: [NavKey, IconName, string[]][] }[] = [
  { group: 'overview', items: [['dashboard', 'dashboard', []]] },
  {
    group: 'research',
    items: [
      ['projects', 'folder', ['project']],
      ['accounts', 'users', ['account']],
      ['explore', 'search', []],
      ['insights', 'trend', []],
      ['apps', 'phone', ['app']],
    ],
  },
  {
    group: 'automation',
    items: [
      ['builder', 'workflow', []],
      ['workflows', 'clock', []],
      ['jobs', 'activity', []],
    ],
  },
  {
    group: 'output',
    items: [
      ['exports', 'download', []],
      ['reports', 'file', []],
    ],
  },
  { group: 'system', items: [['sources', 'database', []]] },
];

function Prefs() {
  const { lang, setLang, theme, setTheme } = usePrefs();
  const t = useT(M);
  const langs: [Lang, string][] = [
    ['en', 'EN'],
    ['vi', 'VI'],
  ];
  const themes: [Theme, string, string][] = [
    ['system', '◐', t('themeSystem')],
    ['light', '☀', t('themeLight')],
    ['dark', '☾', t('themeDark')],
  ];
  return (
    <div className="prefs">
      <div className="seg" role="group" aria-label={t('language')}>
        {langs.map(([l, label]) => (
          <button key={l} aria-pressed={lang === l} onClick={() => setLang(l)} title={l === 'en' ? 'English' : 'Tiếng Việt'}>
            {label}
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label={t('theme')}>
        {themes.map(([th, icon, label]) => (
          <button key={th} aria-pressed={theme === th} onClick={() => setTheme(th)} title={label} aria-label={label}>
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [key, setKey] = useState(0);
  useEffect(() => {
    const on = () => {
      setRoute(parseHash());
      setKey((k) => k + 1);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [guideOpen, setGuideOpen] = useState(false);
  const t = useT(M);
  const { lang } = usePrefs();
  const setup = useSetupStatus();
  // First visit: open the setup guide once.
  useEffect(() => {
    if (!guideSeen()) setGuideOpen(true);
  }, []);
  const isActive = (p: string, also: string[]) => route.page === p || also.includes(route.page);
  return (
    <div className="shell">
      <aside className="sidebar" aria-label={t('nav')}>
        <a className="brand" href="#/dashboard">
          <span className="brand-mark" aria-hidden="true">
            ◎
          </span>
          <span>
            Social Spy
            <small>{t('tagline')}</small>
          </span>
        </a>
        {NAV.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <div className="nav-group">{t(g.group)}</div>
            {g.items.map(([p, icon, also]) => (
              <a key={p} href={`#/${p}`} className={`nav-link${isActive(p, also) ? ' active' : ''}`} aria-current={isActive(p, also) ? 'page' : undefined}>
                <Icon name={icon} />
                {t(p)}
              </a>
            ))}
          </div>
        ))}
        <a className="nav-link" href="/api/docs" target="_blank" rel="noopener noreferrer">
          <Icon name="code" />
          {t('apiDocs')}
        </a>
        <div className="sidebar-foot">
          <button className="setup-card" onClick={() => setGuideOpen(true)}>
            <b>
              {t('setupGuide')} <span style={{ margin: 0 }}>{setup.data ? `${setup.done}/${setup.total}` : ''}</span>
            </b>
            <span>{setup.data ? (setup.done === setup.total ? t('setupDone') : t('setupTodo')) : t('setupHint')}</span>
            <div className="progress" aria-hidden="true">
              <i style={{ width: `${setup.data ? (100 * setup.done) / setup.total : 0}%` }} />
            </div>
          </button>
          <Prefs />
        </div>
      </aside>
      {guideOpen && (
        <SetupGuide
          status={setup.data}
          error={setup.error}
          onRecheck={setup.reload}
          onClose={() => {
            markGuideSeen();
            setGuideOpen(false);
            setup.reload();
          }}
        />
      )}
      <main key={`${key}-${lang}`}>
        {route.page === 'dashboard' && <Dashboard />}
        {route.page === 'projects' && <Projects />}
        {route.page === 'project' && <ProjectPage id={route.id} />}
        {route.page === 'accounts' && <Accounts />}
        {route.page === 'account' && <AccountPage id={route.id} />}
        {route.page === 'explore' && <Explorer />}
        {route.page === 'insights' && <Insights />}
        {route.page === 'apps' && <Apps />}
        {route.page === 'app' && <AppPage id={route.id} />}
        {route.page === 'jobs' && <Jobs />}
        {route.page === 'workflows' && <Workflows />}
        {route.page === 'builder' && <Builder id={route.id} />}
        {route.page === 'exports' && <Exports />}
        {route.page === 'reports' && <Reports />}
        {route.page === 'sources' && <Sources />}
      </main>
    </div>
  );
}

applyTheme(initialTheme()); // before the first paint: no flash of the wrong theme

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <App />
    </PrefsProvider>
  </StrictMode>,
);
