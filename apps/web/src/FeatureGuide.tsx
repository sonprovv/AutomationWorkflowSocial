import { useEffect, useRef, useState } from 'react';
import { defineMessages, usePrefs, useT } from './i18n.tsx';
import { Icon, type IconName } from './icons.tsx';
import { Rich } from './SetupGuide.tsx';

/*
 * Feature guide ("how to use"): what each page is for, how to use it step by step, and its limits.
 * Opens from the sidebar, from the "?" button on every page (at that page's section) and from the setup guide.
 * Text supports `code` and **bold** (see Rich). Every entry has English and Vietnamese.
 */

type Pair = readonly [en: string, vi: string];
interface Section {
  id: string;
  icon: IconName;
  title: Pair;
  summary: Pair;
  steps: Pair[];
  tips?: Pair[];
  /** Route to open; omitted for the overview. */
  page?: string;
}

export const SECTIONS: Section[] = [
  {
    id: 'start',
    icon: 'book',
    title: ['Start here: how it fits together', 'Bắt đầu: cách mọi thứ kết nối'],
    summary: [
      'Social Spy collects public data about competitors from official sources, keeps where every number came from, and turns it into dashboards, alerts, reports and exports. Suggested order for a new setup:',
      'Social Spy thu thập dữ liệu công khai về đối thủ từ các nguồn chính thức, ghi rõ nguồn gốc từng con số và biến chúng thành bảng tổng quan, cảnh báo, báo cáo và file xuất. Thứ tự gợi ý khi mới bắt đầu:',
    ],
    steps: [
      ['**Projects:** create a project for the market you watch (platforms, languages).', '**Dự án:** tạo một dự án cho thị trường bạn theo dõi (nền tảng, ngôn ngữ).'],
      ['**Keywords and discovery:** add seed keywords, run discovery, approve the candidates that really are competitors.', '**Từ khóa và khám phá:** thêm từ khóa gốc, chạy khám phá, duyệt những ứng viên đúng là đối thủ.'],
      ['**Accounts:** or track known competitors directly by profile URL. Tracked accounts sync automatically.', '**Tài khoản:** hoặc theo dõi trực tiếp đối thủ đã biết bằng link hồ sơ. Tài khoản đang theo dõi được đồng bộ tự động.'],
      ['**Dashboard and Content Explorer:** read what competitors publish and how it performs.', '**Tổng quan và Khám phá nội dung:** xem đối thủ đăng gì và hiệu quả ra sao.'],
      ['**Insights:** viral scores, trends and AI summaries (after the data policy is approved).', '**Phân tích:** điểm lan truyền, xu hướng và tóm tắt AI (sau khi chính sách dữ liệu được duyệt).'],
      ['**Schedules, Reports and Workflow Builder:** automate the routine and get reports by Telegram or email.', '**Lịch chạy, Báo cáo và Trình tạo quy trình:** tự động hóa việc lặp lại và nhận báo cáo qua Telegram hoặc email.'],
    ],
    tips: [
      ['A missing value shows as **—** (hover it for the reason). It is never shown as 0.', 'Giá trị thiếu hiển thị là **—** (rê chuột để xem lý do), không bao giờ hiển thị thành 0.'],
      ['Every number keeps its source and collection time. Sources that are blocked or need approval are shown as BLOCKED or AUTH_REQUIRED, never as "0 results".', 'Mọi con số đều kèm nguồn và thời điểm thu thập. Nguồn bị chặn hoặc cần cấp quyền hiển thị là BLOCKED hoặc AUTH_REQUIRED, không bao giờ là "0 kết quả".'],
      ['Data policies are deny-by-default: history, scores, AI and export of a source stay off until you approve its policy.', 'Chính sách dữ liệu mặc định là chặn: lịch sử, chấm điểm, AI và xuất dữ liệu của một nguồn vẫn tắt cho đến khi bạn duyệt chính sách.'],
    ],
  },
  {
    id: 'dashboard',
    icon: 'dashboard',
    page: 'dashboard',
    title: ['Dashboard', 'Tổng quan'],
    summary: ['The overview: counts, posting activity, the latest and most-liked posts, the schedule and the health of each data source.', 'Bức tranh chung: số liệu tổng, hoạt động đăng bài, bài mới nhất và bài nhiều lượt thích nhất, lịch chạy và tình trạng từng nguồn dữ liệu.'],
    steps: [
      ['Pick a project at the top to filter everything, or keep **All projects**.', 'Chọn dự án ở trên cùng để lọc tất cả, hoặc giữ **Tất cả dự án**.'],
      ['Read the tiles: tracked accounts, posts stored, posts collected in 24 h / 7 days, candidates waiting for review.', 'Xem các ô số: tài khoản đang theo dõi, bài đã lưu, bài thu thập trong 24 giờ / 7 ngày, ứng viên chờ duyệt.'],
      ['Click a post to open it on the platform. The line under it shows the source and when it was collected.', 'Bấm vào bài để mở trên nền tảng gốc. Dòng bên dưới cho biết nguồn và thời điểm thu thập.'],
    ],
    tips: [['"Most liked" sorts by the raw like count reported by the platform. It is not a viral score.', '"Nhiều lượt thích nhất" sắp xếp theo số lượt thích gốc do nền tảng trả về, không phải điểm lan truyền.']],
  },
  {
    id: 'projects',
    icon: 'folder',
    page: 'projects',
    title: ['Projects, keywords and discovery', 'Dự án, từ khóa và khám phá'],
    summary: ['A project is one market or product you watch. Inside it you manage keywords, discover new competitor accounts and review them.', 'Mỗi dự án là một thị trường hoặc sản phẩm bạn theo dõi. Trong dự án, bạn quản lý từ khóa, khám phá tài khoản đối thủ mới và duyệt chúng.'],
    steps: [
      ['Create a project: a name, languages (for example `en, vi`) and the platforms to use.', 'Tạo dự án: tên, ngôn ngữ (ví dụ `en, vi`) và các nền tảng cần dùng.'],
      ['Open it and add **keywords** (comma separated). **Suggest variants (rule-based)** proposes related forms; only ACTIVE keywords are searched.', 'Mở dự án và thêm **từ khóa** (cách nhau bằng dấu phẩy). **Gợi ý biến thể (theo quy tắc)** đề xuất các dạng liên quan; chỉ từ khóa đang bật (ACTIVE) mới được tìm.'],
      ['Press **Run discovery**. It searches each platform and lists accounts with a score, the reasons and sample posts as evidence.', 'Bấm **Chạy khám phá**. Hệ thống tìm trên từng nền tảng và liệt kê tài khoản kèm điểm, lý do và bài mẫu làm bằng chứng.'],
      ['In the **review queue**, tick real competitors and press **Approve & track**: they are tracked and synced. **Reject** the rest.', 'Trong **hàng chờ duyệt**, chọn các đối thủ thật và bấm **Duyệt và theo dõi**: chúng sẽ được theo dõi và đồng bộ. **Từ chối** phần còn lại.'],
      ['Optional: turn on automatic discovery every 24 h in the project settings.', 'Tùy chọn: bật tự động khám phá mỗi 24 giờ trong cài đặt dự án.'],
    ],
    tips: [
      ['The coverage list shows, per platform and keyword, whether the search worked, failed or was skipped. A failed search is not "no competitors".', 'Danh sách phạm vi cho biết với từng nền tảng và từ khóa, việc tìm thành công, lỗi hay bị bỏ qua. Tìm lỗi không có nghĩa là "không có đối thủ".'],
      ['Without a Bluesky App Password, keyword search returns the first page of results only.', 'Khi chưa có App Password của Bluesky, tìm theo từ khóa chỉ trả về trang kết quả đầu tiên.'],
    ],
  },
  {
    id: 'accounts',
    icon: 'users',
    page: 'accounts',
    title: ['Accounts', 'Tài khoản'],
    summary: ['Every social account you track, with its profile, latest metrics and sync history.', 'Tất cả tài khoản mạng xã hội bạn theo dõi, kèm hồ sơ, chỉ số mới nhất và lịch sử đồng bộ.'],
    steps: [
      ['Paste a profile URL or handle (for example `https://bsky.app/profile/name.bsky.social`), choose a project and press **Track account**.', 'Dán link hồ sơ hoặc handle (ví dụ `https://bsky.app/profile/name.bsky.social`), chọn dự án rồi bấm **Theo dõi tài khoản**.'],
      ['Open an account: **Sync now** fetches new posts; **Refresh metrics** updates likes, comments and shares of recent posts.', 'Mở một tài khoản: **Đồng bộ ngay** lấy bài mới; **Làm mới chỉ số** cập nhật lượt thích, bình luận, chia sẻ của các bài gần đây.'],
      ['**Sync history** lists every call to the platform: status, number of records, time taken and any error.', '**Lịch sử đồng bộ** liệt kê mọi lần gọi tới nền tảng: trạng thái, số bản ghi, thời gian và lỗi nếu có.'],
    ],
    tips: [['Only platforms with a working source can be tracked. TikTok and others show why they are blocked (see Data Sources).', 'Chỉ theo dõi được nền tảng có nguồn hoạt động. TikTok và một số nền tảng khác hiển thị lý do bị chặn (xem Nguồn dữ liệu).']],
  },
  {
    id: 'explore',
    icon: 'search',
    page: 'explore',
    title: ['Content Explorer', 'Khám phá nội dung'],
    summary: ['Search and filter every collected post, then export exactly what you see.', 'Tìm và lọc mọi bài đã thu thập, rồi xuất đúng những gì bạn đang xem.'],
    steps: [
      ['Filter by project, platform, format, text, hashtag and publish date, then press **Apply**.', 'Lọc theo dự án, nền tảng, định dạng, nội dung, hashtag và ngày đăng, rồi bấm **Áp dụng**.'],
      ['Tick **show unavailable** to include posts the platform no longer returns (deleted or hidden).', 'Chọn **hiện bài không khả dụng** để xem cả những bài nền tảng không còn trả về (đã xóa hoặc ẩn).'],
      ['Choose Excel, CSV or JSON and press **Export these results**. The file appears on the Exports page.', 'Chọn Excel, CSV hoặc JSON rồi bấm **Xuất dữ liệu các kết quả này**. File sẽ xuất hiện ở trang Xuất dữ liệu.'],
    ],
    tips: [['Rows whose source policy does not allow export are left out, and the export says how many and why.', 'Các dòng thuộc nguồn có chính sách không cho xuất sẽ bị bỏ ra, và file xuất ghi rõ số lượng cùng lý do.']],
  },
  {
    id: 'insights',
    icon: 'trend',
    page: 'insights',
    title: ['Insights: viral, trends and AI', 'Phân tích: lan truyền, xu hướng và AI'],
    summary: ['Scores posts that outperform their account, finds rising topics, and has Claude explain why top posts work.', 'Chấm điểm các bài vượt trội so với chính tài khoản đó, tìm chủ đề đang lên, và nhờ Claude giải thích vì sao các bài nổi bật hiệu quả.'],
    steps: [
      ['Choose a project, press **Score now** in the viral feed and **Compute (7 days)** under Trends.', 'Chọn dự án, bấm **Chấm điểm ngay** ở bảng tin lan truyền và **Tính toán (7 ngày)** ở phần Xu hướng.'],
      ['Press **Analyse top posts** for an AI breakdown: hook, format, call to action and what to learn.', 'Bấm **Phân tích các bài đăng nổi bật** để AI phân tích: câu mở đầu, định dạng, lời kêu gọi hành động và bài học rút ra.'],
    ],
    tips: [
      ['These features use derived metrics, so they report "blocked by policy" until the source policy (for Bluesky) is approved.', 'Các tính năng này dùng chỉ số suy diễn nên sẽ báo "blocked by policy" cho tới khi chính sách của nguồn (Bluesky) được duyệt.'],
      ['AI analysis needs `ANTHROPIC_API_KEY` (see the setup guide). Scores show INSUFFICIENT_DATA when an account has too few posts.', 'Phân tích AI cần `ANTHROPIC_API_KEY` (xem hướng dẫn cài đặt). Điểm hiển thị INSUFFICIENT_DATA khi tài khoản có quá ít bài.'],
    ],
  },
  {
    id: 'apps',
    icon: 'phone',
    page: 'apps',
    title: ['App Spy', 'App Spy'],
    summary: ["Research competitors' iOS apps from the official App Store API, and find their social accounts from evidence.", 'Nghiên cứu ứng dụng iOS của đối thủ qua API chính thức của App Store, và tìm tài khoản mạng xã hội của họ dựa trên bằng chứng.'],
    steps: [
      ['Search the App Store (results are suggestions) or paste an App Store link, numeric id or bundle id, then **Track app**.', 'Tìm trên App Store (kết quả chỉ là gợi ý) hoặc dán link App Store, id số hoặc bundle id, rồi bấm **Theo dõi ứng dụng**.'],
      ["Open an app: rating and count, price, version and dates per storefront. **Developer's other apps** lists the rest of their catalogue.", 'Mở một ứng dụng: điểm và số lượt đánh giá, giá, phiên bản và các mốc thời gian theo từng cửa hàng. **Ứng dụng khác của nhà phát triển** liệt kê các app còn lại của họ.'],
      ['Press **Check developer website**: the website listed on the App Store is read once, and the social profiles it links to are proposed with evidence. **Confirm** or **Reject** each one.', 'Bấm **Kiểm tra website nhà phát triển**: website ghi trên App Store được đọc một lần, các hồ sơ mạng xã hội mà nó liên kết được đề xuất kèm bằng chứng. **Xác nhận** hoặc **Từ chối** từng cái.'],
    ],
    tips: [
      ['Apps are never matched to accounts by name. HIGH = the link is on the listed site; MEDIUM = the site redirected to another domain.', 'Ứng dụng không bao giờ được ghép với tài khoản theo tên. HIGH = link nằm trên đúng website đã khai; MEDIUM = website chuyển hướng sang tên miền khác.'],
      ['Google Play has no official API, so it is blocked. Downloads, revenue and rankings are not available and are never estimated.', 'Google Play không có API chính thức nên bị chặn. Lượt tải, doanh thu và thứ hạng không có sẵn và không bao giờ được ước tính.'],
    ],
  },
  {
    id: 'builder',
    icon: 'workflow',
    page: 'builder',
    title: ['Workflow Builder', 'Trình tạo quy trình'],
    summary: ['Chain the built-in steps (discover, sync, metrics, viral, trends, AI, export, report, notify) with waits and conditions into your own automation.', 'Nối các bước có sẵn (khám phá, đồng bộ, chỉ số, lan truyền, xu hướng, AI, xuất dữ liệu, báo cáo, thông báo) cùng bước chờ và điều kiện thành quy trình tự động của riêng bạn.'],
    steps: [
      ['Create a workflow from the weekly-scan template or from an empty start, and attach a project.', 'Tạo quy trình từ mẫu quét hằng tuần hoặc bắt đầu trống, rồi gắn với một dự án.'],
      ['Add steps from the right panel. Drag a step to move it; drag from its right-hand dot onto another step to connect them.', 'Thêm bước từ bảng bên phải. Kéo một bước để di chuyển; kéo từ chấm bên phải của nó sang bước khác để nối.'],
      ['Click a step to edit its settings, timeout and what happens on error. Click a connection to delete it or switch an If branch between true and false.', 'Bấm vào bước để sửa cài đặt, thời gian chờ tối đa và cách xử lý khi lỗi. Bấm vào kết nối để xóa hoặc đổi nhánh If giữa true và false.'],
      ['**Validate**, **Save new version**, then **Run now**. Pick a run to colour each step by its result.', '**Kiểm tra**, **Lưu phiên bản mới**, rồi **Chạy ngay**. Chọn một lần chạy để tô màu từng bước theo kết quả.'],
    ],
    tips: [['Workflows cannot loop (the graph must be acyclic). To repeat, add a CUSTOM_WORKFLOW schedule. Old versions stay readable and can be restored.', 'Quy trình không được lặp vòng (sơ đồ phải không có chu trình). Muốn chạy lặp lại, hãy thêm lịch chạy CUSTOM_WORKFLOW. Các phiên bản cũ vẫn xem được và có thể khôi phục.']],
  },
  {
    id: 'workflows',
    icon: 'clock',
    page: 'workflows',
    title: ['Schedules', 'Lịch chạy'],
    summary: ['The built-in automations: new-post detection, metric refresh, discovery, scoring, provider health checks, backups and clean-up.', 'Các tác vụ tự động có sẵn: phát hiện bài mới, làm mới chỉ số, khám phá, chấm điểm, kiểm tra nguồn dữ liệu, sao lưu và dọn dẹp.'],
    steps: [
      ['Change how often each one runs (minutes), switch it on or off, or **Run now**.', 'Đổi tần suất chạy (phút), bật/tắt từng lịch, hoặc bấm **Chạy ngay**.'],
      ['**Pause all schedules** during maintenance; manual runs still work.', '**Tạm dừng mọi lịch chạy** khi bảo trì; chạy thủ công vẫn hoạt động.'],
    ],
    tips: [['"NOTHING_DUE" means the run had nothing to do (for example no account due for a refresh). It is not an error.', '"NOTHING_DUE" nghĩa là lần chạy không có gì để làm (ví dụ chưa có tài khoản đến hạn làm mới), không phải lỗi.']],
  },
  {
    id: 'jobs',
    icon: 'activity',
    page: 'jobs',
    title: ['Job Monitor', 'Giám sát tác vụ'],
    summary: ['Everything that runs in the background: status, progress, retries and errors.', 'Mọi việc chạy nền: trạng thái, tiến độ, số lần thử lại và lỗi.'],
    steps: [
      ['Watch running jobs. **Cancel** stops one; **Retry** runs a failed or cancelled job again.', 'Theo dõi tác vụ đang chạy. **Hủy** để dừng; **Thử lại** để chạy lại tác vụ lỗi hoặc đã hủy.'],
      ['The failed-jobs panel groups errors by code so you can see what keeps failing.', 'Bảng tác vụ lỗi gom lỗi theo mã để bạn thấy cái gì hay hỏng.'],
    ],
    tips: [['AUTH_REQUIRED, PERMISSION_DENIED and POLICY_BLOCKED are never retried automatically: fix the key or setting first.', 'AUTH_REQUIRED, PERMISSION_DENIED và POLICY_BLOCKED không bao giờ được tự thử lại: hãy sửa key hoặc cấu hình trước.']],
  },
  {
    id: 'exports',
    icon: 'download',
    page: 'exports',
    title: ['Exports', 'Xuất dữ liệu'],
    summary: ['Download Excel, CSV or JSON files made from the Content Explorer or by reports and workflows.', 'Tải file Excel, CSV hoặc JSON tạo từ Khám phá nội dung hoặc từ báo cáo và quy trình.'],
    steps: [['Each export lists its row counts, the rows withheld by policy (and why) and when it expires. Press **Download**.', 'Mỗi bản xuất ghi số dòng, số dòng bị giữ lại theo chính sách (kèm lý do) và ngày hết hạn. Bấm **Tải xuống**.']],
    tips: [['Excel files include a data-dictionary sheet and the source of every row. Cells that look like formulas are neutralised.', 'File Excel có trang giải thích các cột và nguồn của từng dòng. Ô trông giống công thức được vô hiệu hóa để an toàn.']],
  },
  {
    id: 'reports',
    icon: 'file',
    page: 'reports',
    title: ['Reports', 'Báo cáo'],
    summary: ['Daily or weekly summaries of a project, with an attached Excel file, delivered by Telegram, email or webhook.', 'Bản tóm tắt hằng ngày hoặc hằng tuần của một dự án, kèm file Excel, gửi qua Telegram, email hoặc webhook.'],
    steps: [
      ['Choose a project and build a daily or weekly report, or **Build & send** it.', 'Chọn dự án rồi tạo báo cáo ngày hoặc tuần, hoặc **Tạo và gửi** luôn.'],
      ['Set up a channel first (see the setup guide), then press **Send test notification**.', 'Cấu hình kênh gửi trước (xem hướng dẫn cài đặt), rồi bấm **Gửi thông báo thử**.'],
    ],
  },
  {
    id: 'sources',
    icon: 'database',
    page: 'sources',
    title: ['Data Sources', 'Nguồn dữ liệu'],
    summary: ['Which platforms can be used, why the others cannot, the data policy of each, and today’s usage against the daily cap.', 'Nền tảng nào dùng được, vì sao các nền tảng khác chưa dùng được, chính sách dữ liệu của từng nguồn và mức đã dùng hôm nay so với giới hạn ngày.'],
    steps: [['**Test** checks the connection and the credential of a source (it counts toward the daily cap).', '**Kiểm tra** thử kết nối và key của một nguồn (có tính vào giới hạn ngày).']],
    tips: [['✗ under Policy means not allowed until the policy is approved. Details of every source are in `docs/feasibility/`.', '✗ ở cột Chính sách nghĩa là chưa được phép cho tới khi chính sách được duyệt. Chi tiết từng nguồn nằm trong `docs/feasibility/`.']],
  },
];

/** Route page → guide section. */
export function sectionForPage(page: string): string {
  const map: Record<string, string> = { project: 'projects', account: 'accounts', app: 'apps' };
  const id = map[page] ?? page;
  return SECTIONS.some((s) => s.id === id) ? id : 'start';
}

const M = defineMessages({
  title: ['User guide', 'Hướng dẫn sử dụng'],
  subtitle: ['What each page does and how to use it. Press ? on any page to jump here.', 'Mỗi trang dùng để làm gì và dùng thế nào. Bấm ? ở bất kỳ trang nào để mở đúng phần.'],
  close: ['Close user guide', 'Đóng hướng dẫn sử dụng'],
  how: ['How to use it', 'Cách dùng'],
  tips: ['Good to know', 'Lưu ý'],
  open: ['Open this page →', 'Mở trang này →'],
  prev: ['← Previous', '← Trước'],
  next: ['Next →', 'Tiếp →'],
  sections: ['Sections', 'Các phần'],
  setup: ['Setup guide', 'Hướng dẫn cài đặt'],
});

export function FeatureGuide({ initial, onClose, onOpenSetup }: { initial: string; onClose: () => void; onOpenSetup: () => void }) {
  const t = useT(M);
  const { lang } = usePrefs();
  const L = (p: Pair) => p[lang === 'vi' ? 1 : 0];
  const [id, setId] = useState(initial);
  const idx = Math.max(0, SECTIONS.findIndex((s) => s.id === id));
  const sec = SECTIONS[idx]!;
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
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
  useEffect(() => bodyRef.current?.scrollTo({ top: 0 }), [id]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="guide-title" tabIndex={-1} ref={dialogRef}>
        <div className="modal-head">
          <span className="brand-mark" aria-hidden="true" style={{ width: 38, height: 38, fontSize: 18 }}>
            ?
          </span>
          <div style={{ flex: 1 }}>
            <h2 id="guide-title">{t('title')}</h2>
            <p>{t('subtitle')}</p>
          </div>
          <button className="ghost" onClick={onClose} aria-label={t('close')}>
            ✕
          </button>
        </div>
        <div className="guide-layout">
          <nav className="guide-nav" aria-label={t('sections')}>
            {SECTIONS.map((s, i) => (
              <button key={s.id} className={`nav-link${s.id === sec.id ? ' active' : ''}`} aria-current={s.id === sec.id ? 'true' : undefined} onClick={() => setId(s.id)}>
                <Icon name={s.icon} />
                <span>
                  {i === 0 ? '' : `${i}. `}
                  {L(s.title)}
                </span>
              </button>
            ))}
          </nav>
          <div className="guide-content" ref={bodyRef}>
            <h3 className="guide-title">
              <Icon name={sec.icon} />
              {L(sec.title)}
            </h3>
            <p className="guide-summary">
              <Rich text={L(sec.summary)} />
            </p>
            <div className="guide-group">{t('how')}</div>
            <ol className="guide-steps">
              {sec.steps.map((st, i) => (
                <li key={i}>
                  <Rich text={L(st)} />
                </li>
              ))}
            </ol>
            {sec.tips && (
              <>
                <div className="guide-group">{t('tips')}</div>
                <ul className="guide-tips">
                  {sec.tips.map((tp, i) => (
                    <li key={i}>
                      <Rich text={L(tp)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {sec.page && (
              <div className="step-actions" style={{ marginTop: 16 }}>
                <a
                  href={`#/${sec.page}`}
                  onClick={() => {
                    onClose();
                  }}
                >
                  {t('open')}
                </a>
              </div>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onOpenSetup}>
            {t('setup')}
          </button>
          <span style={{ flex: 1 }} />
          <button disabled={idx === 0} onClick={() => setId(SECTIONS[idx - 1]!.id)}>
            {t('prev')}
          </button>
          {idx < SECTIONS.length - 1 ? (
            <button className="primary" onClick={() => setId(SECTIONS[idx + 1]!.id)}>
              {t('next')}
            </button>
          ) : (
            <button className="primary" onClick={onClose}>
              ✓
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
