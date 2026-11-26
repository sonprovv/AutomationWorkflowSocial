import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { api, type Page, type Project } from '../api.ts';
import {
  addNode,
  canvasSize,
  connect,
  IF,
  NODE_H,
  NODE_W,
  removeEdge,
  removeNode,
  renameNode,
  toggleWhen,
  TRIGGER,
  updateNode,
  withPositions,
  type GEdge,
  type GNode,
  type Graph,
  type JsonSchema,
  type NodeTypeInfo,
} from '../graph-edit.ts';
import { ACTIVE, Empty, errText, ErrorBox, fmtTime, Loading, Status, usePoll, useLoad } from '../ui.tsx';
import { currentLocale, defineMessages, useT } from '../i18n.tsx';

const M = defineMessages({
  // list + create
  title: ['Workflow Builder', 'Trình tạo quy trình'],
  intro1: [
    'Custom workflows chain the existing guarded jobs (discovery, sync, metrics, viral, trends, AI, export, report, notify) with wait and if steps. Graphs must be acyclic; every save is a new version and every run pins one. Recurring runs use a',
    'Quy trình tùy chỉnh nối các tác vụ có kiểm soát sẵn có (khám phá, đồng bộ, chỉ số, viral, xu hướng, AI, xuất dữ liệu, báo cáo, thông báo) với các bước chờ (wait) và điều kiện (if). Sơ đồ không được có vòng lặp; mỗi lần lưu tạo một phiên bản mới và mỗi lần chạy gắn với một phiên bản. Lần chạy định kỳ dùng lịch',
  ],
  intro2: ['schedule on the Schedules page.', 'trên trang Lịch chạy.'],
  name: ['Name', 'Tên'],
  namePh: ['Weekly market scan', 'Quét thị trường hàng tuần'],
  projectNeeded: ['Project (needed to run)', 'Dự án (cần để chạy)'],
  noneYet: ['— none yet —', '— chưa có —'],
  startFrom: ['Start from', 'Bắt đầu từ'],
  tplWeekly: ['Template: weekly market scan', 'Mẫu: quét thị trường hàng tuần'],
  tplEmpty: ['Empty (start node only)', 'Trống (chỉ có bước Bắt đầu)'],
  create: ['Create workflow', 'Tạo quy trình'],
  noWorkflows: ['No custom workflows yet.', 'Chưa có quy trình tùy chỉnh nào.'],
  colWorkflow: ['Workflow', 'Quy trình'],
  colProject: ['Project', 'Dự án'],
  colStatus: ['Status', 'Trạng thái'],
  colVersion: ['Version', 'Phiên bản'],
  colUpdated: ['Updated', 'Cập nhật'],
  // editor
  savedAs: ['Saved as version {n}.', 'Đã lưu thành phiên bản {n}.'],
  runQueued: ['Run queued (job {job}, {status}). Node colours follow the newest run.', 'Đã xếp hàng lần chạy (tác vụ {job}, {status}). Màu các bước theo lần chạy mới nhất.'],
  discardConfirm: ['Discard unsaved changes?', 'Bỏ các thay đổi chưa lưu?'],
  showingVersion: ['Showing version {n}. Save to make it the current version again.', 'Đang xem phiên bản {n}. Lưu để đặt lại làm phiên bản hiện tại.'],
  blockSave: ['Save first', 'Hãy lưu trước'],
  blockOld: ['Showing an old version', 'Đang xem phiên bản cũ'],
  blockProject: ['Attach a project first', 'Hãy gắn dự án trước'],
  blockStatus: ['Workflow is {s}', 'Quy trình đang ở trạng thái {s}'],
  allWorkflows: ['← All workflows', '← Tất cả quy trình'],
  ariaName: ['Workflow name', 'Tên quy trình'],
  noProject: ['— no project —', '— không có dự án —'],
  archiveConfirm: ['Archive this workflow? It disappears from the list.', 'Lưu trữ quy trình này? Quy trình sẽ biến mất khỏi danh sách.'],
  current: [' (current)', ' (hiện tại)'],
  unsaved: ['unsaved', 'chưa lưu'],
  validate: ['Validate', 'Kiểm tra'],
  saveNew: ['Save new version', 'Lưu phiên bản mới'],
  starting: ['Starting…', 'Đang khởi chạy…'],
  runNow: ['Run now', 'Chạy ngay'],
  runDisabled: ['Run disabled: {r}.', 'Không thể chạy: {r}.'],
  valid: ['Valid. Execution order: {order}', 'Hợp lệ. Thứ tự thực thi: {order}'],
  notValid: ['Not valid:', 'Không hợp lệ:'],
  // canvas
  ariaGraph: ['Workflow graph editor', 'Trình chỉnh sửa sơ đồ quy trình'],
  portTitle: ['Drag onto another node to connect', 'Kéo sang bước khác để kết nối'],
  hint: [
    'Drag a node to move it · drag from its right-hand port onto another node to connect · click an edge to select it · Delete removes the selection.',
    'Kéo một bước để di chuyển · kéo từ cổng bên phải của bước sang bước khác để kết nối · nhấp vào một kết nối để chọn · phím Delete xóa mục đang chọn.',
  ],
  // palette
  addStep: ['Add a step', 'Thêm bước'],
  paletteHelp: [
    'Select a node or edge to edit it. Steps marked policy-gated report “blocked by policy” until the source allows derived metrics.',
    'Chọn một bước hoặc kết nối để chỉnh sửa. Các bước bị chặn theo chính sách sẽ báo “blocked by policy” cho đến khi nguồn cho phép chỉ số dẫn xuất.',
  ],
  // node panel
  id: ['Id', 'Id'],
  labelOpt: ['Label (optional)', 'Nhãn (không bắt buộc)'],
  settings: ['Settings', 'Cài đặt'],
  timeout: ['Timeout (seconds, 10–3600)', 'Thời gian chờ tối đa (giây, 10–3600)'],
  onError: ['On error', 'Khi lỗi'],
  errStop: ['stop the run', 'dừng lần chạy'],
  errContinue: ['continue with the next steps', 'tiếp tục các bước sau'],
  selectedRun: ['Selected run:', 'Lần chạy đã chọn:'],
  startedAt: ['started {t}', 'bắt đầu lúc {t}'],
  finishedAt: ['finished {t}', 'kết thúc lúc {t}'],
  jobs: ['jobs: {ids}', 'tác vụ: {ids}'],
  result: ['Result', 'Kết quả'],
  deleteStep: ['Delete step', 'Xóa bước'],
  done: ['Done', 'Xong'],
  // edge panel
  connection: ['Connection', 'Kết nối'],
  runsWhen: ['Runs when the condition is', 'Chạy khi điều kiện là'],
  switchTo: ['Switch to {v}', 'Chuyển sang {v}'],
  deleteConnection: ['Delete connection', 'Xóa kết nối'],
  // generated fields
  optional: [' (optional)', ' (không bắt buộc)'],
  commaSep: ['comma-separated', 'phân tách bằng dấu phẩy'],
  numOrText: ['number or text', 'số hoặc văn bản'],
  // runs
  runs: ['Runs', 'Lần chạy'],
  noRuns: ['No runs yet.', 'Chưa có lần chạy nào.'],
  colStarted: ['Started', 'Bắt đầu lúc'],
  colSteps: ['Steps', 'Bước'],
  colError: ['Error', 'Lỗi'],
  showOnGraph: ['Show on graph', 'Hiện trên sơ đồ'],
  hideOnGraph: ['Hide on graph', 'Ẩn khỏi sơ đồ'],
  cancel: ['Cancel', 'Hủy'],
});

/*
 * Workflow Builder (Phase 9, P9-02): a small dependency-free SVG editor for the versioned workflow DAG.
 * Drag nodes to move them, drag from a node's right-hand port onto another node to connect, click an edge to
 * select it (if-edges toggle true/false), Delete removes the selection. Validate asks the server; Save stores a
 * new immutable version; Run queues the current version. A selected run colours each node by its step status.
 */

interface WorkflowDef {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  status: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}
interface WorkflowDetail extends WorkflowDef {
  graph: Graph | null;
  versions: { version: number; createdAt: string }[];
}
interface Step {
  status: string;
  jobIds: string[];
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
}
interface WorkflowRun {
  id: string;
  version: number;
  status: string;
  steps: Record<string, Step>;
  jobId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
interface Validation {
  ok: boolean;
  errors: string[];
  order: string[];
}

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; index: number } | null;

const STEP_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--ok)',
  PARTIAL_SUCCESS: 'var(--warn)',
  FAILED: 'var(--bad)',
  RUNNING: 'var(--accent)',
  PENDING: 'var(--muted)',
  SKIPPED: 'var(--muted)',
  CANCELLED: 'var(--muted)',
};

/* ---------------- list + create ---------------- */
export function Builder({ id }: { id?: string }) {
  return id ? <Editor id={id} /> : <BuilderList />;
}

function BuilderList() {
  const t = useT(M);
  const defs = useLoad(() => api<{ items: WorkflowDef[] }>('/workflow-defs'), []);
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [template, setTemplate] = useState<'weekly-scan' | 'empty'>('weekly-scan');
  const [err, setErr] = useState<string | null>(null);
  const projectName = (pid: string | null) => projects.data?.items.find((p) => p.id === pid)?.name ?? null;

  async function create() {
    setErr(null);
    try {
      const d = await api<WorkflowDetail>('/workflow-defs', { method: 'POST', body: { name: name.trim(), template, ...(projectId ? { projectId } : {}) } });
      location.hash = `#/builder/${d.id}`;
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <>
      <h2>{t('title')}</h2>
      <p className="muted small">
        {t('intro1')} <code>CUSTOM_WORKFLOW</code> {t('intro2')}
      </p>
      <div className="filters">
        <label>
          {t('name')}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePh')} />
        </label>
        <label>
          {t('projectNeeded')}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t('noneYet')}</option>
            {projects.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('startFrom')}
          <select value={template} onChange={(e) => setTemplate(e.target.value as 'weekly-scan' | 'empty')}>
            <option value="weekly-scan">{t('tplWeekly')}</option>
            <option value="empty">{t('tplEmpty')}</option>
          </select>
        </label>
        <button className="primary" disabled={!name.trim()} onClick={create}>
          {t('create')}
        </button>
      </div>
      <ErrorBox error={err ?? defs.error} />
      <Loading on={defs.loading} />
      {defs.data && defs.data.items.length === 0 && <Empty>{t('noWorkflows')}</Empty>}
      {defs.data && defs.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('colWorkflow')}</th>
              <th>{t('colProject')}</th>
              <th>{t('colStatus')}</th>
              <th>{t('colVersion')}</th>
              <th>{t('colUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {defs.data.items.map((d) => (
              <tr key={d.id}>
                <td>
                  <a href={`#/builder/${d.id}`}>{d.name}</a>
                  {d.description && <div className="muted small">{d.description}</div>}
                </td>
                <td>{projectName(d.projectId) ?? <span className="muted">—</span>}</td>
                <td>
                  <Status s={d.status} />
                </td>
                <td>v{d.currentVersion}</td>
                <td className="small">{fmtTime(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ---------------- editor ---------------- */
function Editor({ id }: { id: string }) {
  const t = useT(M);
  const def = useLoad(() => api<WorkflowDetail>(`/workflow-defs/${id}`), [id]);
  const types = useLoad(() => api<{ items: NodeTypeInfo[] }>('/workflow-defs/node-types'), []);
  const projects = useLoad(() => api<Page<Project>>('/projects?limit=100'), []);
  const runs = useLoad(() => api<{ items: WorkflowRun[] }>(`/workflow-defs/${id}/runs`), [id]);

  const [graph, setGraph] = useState<Graph | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Selection>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load the current version into the editor once (and after saving).
  useEffect(() => {
    if (def.data && graph === null && def.data.graph) {
      setGraph(withPositions(def.data.graph));
      setBaseVersion(def.data.currentVersion);
    }
  }, [def.data, graph]);

  const typeInfo = useMemo(() => new Map((types.data?.items ?? []).map((t) => [t.type, t])), [types.data]);
  const run = runs.data?.items.find((r) => r.id === runId) ?? null;
  const anyActive = (runs.data?.items ?? []).some((r) => r.status === 'RUNNING');
  usePoll(runs.reload, anyActive || busy, 1500);

  const edit = useCallback((g: Graph) => {
    setGraph(g);
    setDirty(true);
    setValidation(null);
  }, []);

  // Delete key removes the selection (not while typing in a field).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      if (!graph || !sel) return;
      if (sel.kind === 'node' && graph.nodes.find((n) => n.id === sel.id)?.type === TRIGGER) return;
      e.preventDefault();
      edit(sel.kind === 'node' ? removeNode(graph, sel.id) : removeEdge(graph, sel.index));
      setSel(null);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [graph, sel, edit]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, [dirty]);

  if (def.error) return <ErrorBox error={def.error} />;
  if (!def.data || !graph) return <Loading on />;
  const d = def.data;

  async function patch(body: Record<string, unknown>) {
    try {
      await api(`/workflow-defs/${id}`, { method: 'PATCH', body });
      def.reload();
      setMsg(null);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  async function validate() {
    try {
      const v = await api<Validation>(`/workflow-defs/${id}/validate`, { method: 'POST', body: { graph } });
      setValidation(v);
      return v;
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      return null;
    }
  }

  async function save() {
    const v = await validate();
    if (!v?.ok) return;
    try {
      const r = await api<{ version: number }>(`/workflow-defs/${id}/versions`, { method: 'POST', body: { graph } });
      setDirty(false);
      setBaseVersion(r.version);
      setMsg({ ok: true, text: t('savedAs', { n: r.version }) });
      def.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      const r = await api<{ job_id: string; status: string }>(`/workflow-defs/${id}/run`, { method: 'POST', body: {} });
      setMsg({ ok: true, text: t('runQueued', { job: r.job_id.slice(0, 8), status: r.status }) });
      setRunId(null);
      // The run row appears once the worker picks the job up; follow the newest run then.
      for (let i = 0; i < 20; i++) {
        const list = await api<{ items: WorkflowRun[] }>(`/workflow-defs/${id}/runs`);
        const mine = list.items.find((x) => x.jobId === r.job_id);
        if (mine) {
          setRunId(mine.id);
          break;
        }
        await new Promise((x) => setTimeout(x, 500));
      }
      runs.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function loadVersion(version: number) {
    if (dirty && !window.confirm(t('discardConfirm'))) return;
    try {
      const v = await api<{ graph: Graph }>(`/workflow-defs/${id}/versions/${version}`);
      setGraph(withPositions(v.graph));
      setBaseVersion(version);
      setDirty(false);
      setSel(null);
      setValidation(null);
      setMsg(version === d.currentVersion ? null : { ok: true, text: t('showingVersion', { n: version }) });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  const viewingOld = baseVersion !== null && baseVersion !== d.currentVersion;
  const canRun = !dirty && !viewingOld && !!d.projectId && d.status !== 'PAUSED' && d.status !== 'ARCHIVED';
  const runBlocker = dirty
    ? t('blockSave')
    : viewingOld
      ? t('blockOld')
      : !d.projectId
        ? t('blockProject')
        : d.status === 'PAUSED' || d.status === 'ARCHIVED'
          ? t('blockStatus', { s: d.status })
          : '';

  return (
    <>
      <p className="small">
        <a href="#/builder">{t('allWorkflows')}</a>
      </p>
      <div className="row">
        <input
          className="narrow"
          style={{ width: 280, fontWeight: 600 }}
          defaultValue={d.name}
          key={d.name}
          aria-label={t('ariaName')}
          onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== d.name && patch({ name: e.target.value.trim() })}
        />
        <select aria-label={t('colProject')} value={d.projectId ?? ''} onChange={(e) => patch({ projectId: e.target.value || null })}>
          <option value="">{t('noProject')}</option>
          {projects.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select aria-label={t('colStatus')} value={d.status} onChange={(e) => (e.target.value !== 'ARCHIVED' || window.confirm(t('archiveConfirm'))) && patch({ status: e.target.value })}>
          {['DRAFT', 'ENABLED', 'PAUSED', 'ARCHIVED'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select aria-label={t('colVersion')} value={baseVersion ?? d.currentVersion} onChange={(e) => loadVersion(Number(e.target.value))}>
          {d.versions.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version}
              {v.version === d.currentVersion ? t('current') : ''} · {new Date(v.createdAt).toLocaleString(currentLocale())}
            </option>
          ))}
        </select>
        {dirty && <span className="badge badge-pending">{t('unsaved')}</span>}
        <span style={{ flex: 1 }} />
        <button onClick={validate}>{t('validate')}</button>
        <button onClick={save} disabled={!dirty && !viewingOld}>
          {t('saveNew')}
        </button>
        <button className="primary" onClick={runNow} disabled={!canRun || busy} title={runBlocker}>
          {busy ? t('starting') : t('runNow')}
        </button>
      </div>
      {runBlocker && !dirty && <p className="muted small">{t('runDisabled', { r: runBlocker })}</p>}
      {msg && <div className={msg.ok ? 'ok' : 'error'}>{msg.text}</div>}
      {validation && (
        <div className={validation.ok ? 'ok' : 'error'}>
          {validation.ok ? (
            <>{t('valid', { order: validation.order.join(' → ') })}</>
          ) : (
            <>
              <b>{t('notValid')}</b>
              <ul style={{ margin: '4px 0 0' }}>
                {validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className="builder">
        <Canvas graph={graph} typeInfo={typeInfo} sel={sel} setSel={setSel} onChange={edit} onMove={setGraph} onDirty={() => setDirty(true)} run={run} onError={(t) => setMsg({ ok: false, text: t })} />
        <aside className="builder-side">
          {sel?.kind === 'node' && graph.nodes.some((n) => n.id === sel.id) ? (
            <NodePanel
              key={sel.id}
              graph={graph}
              node={graph.nodes.find((n) => n.id === sel.id)!}
              info={typeInfo.get(graph.nodes.find((n) => n.id === sel.id)!.type)}
              step={run?.steps[sel.id]}
              onChange={edit}
              onSelect={(nid) => setSel(nid ? { kind: 'node', id: nid } : null)}
              onError={(t) => setMsg({ ok: false, text: t })}
            />
          ) : sel?.kind === 'edge' && graph.edges[sel.index] ? (
            <EdgePanel graph={graph} index={sel.index} onChange={edit} onDone={() => setSel(null)} />
          ) : (
            <Palette
              types={types.data?.items ?? []}
              onAdd={(info) => {
                const r = addNode(graph, info);
                edit(r.graph);
                setSel({ kind: 'node', id: r.id });
              }}
            />
          )}
        </aside>
      </div>
      <Runs runs={runs.data?.items ?? []} selected={runId} onSelect={setRunId} onCancel={async (jobId) => (await api(`/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {}), runs.reload())} />
    </>
  );
}

/* ---------------- canvas ---------------- */
type Drag = { kind: 'move'; id: string; dx: number; dy: number } | { kind: 'link'; from: string; x: number; y: number } | null;

function Canvas(p: {
  graph: Graph;
  typeInfo: Map<string, NodeTypeInfo>;
  sel: Selection;
  setSel: (s: Selection) => void;
  onChange: (g: Graph) => void;
  onMove: (g: Graph) => void;
  onDirty: () => void;
  run: WorkflowRun | null;
  onError: (t: string) => void;
}) {
  const t = useT(M);
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const moved = useRef(false);
  const { w, h } = canvasSize(p.graph);
  const pos = (n: GNode) => n.position ?? { x: 0, y: 0 };
  const byId = new Map(p.graph.nodes.map((n) => [n.id, n]));

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const nodeAt = (x: number, y: number) => p.graph.nodes.find((n) => x >= pos(n).x && x <= pos(n).x + NODE_W && y >= pos(n).y && y <= pos(n).y + NODE_H);

  function onPointerMove(e: RPointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const pt = local(e);
    if (drag.kind === 'move') {
      moved.current = true;
      const x = Math.max(0, Math.round((pt.x - drag.dx) / 10) * 10);
      const y = Math.max(0, Math.round((pt.y - drag.dy) / 10) * 10);
      p.onMove(updateNode(p.graph, drag.id, { position: { x, y } }));
    } else setDrag({ ...drag, x: pt.x, y: pt.y });
  }
  function onPointerUp(e: RPointerEvent<SVGSVGElement>) {
    if (drag?.kind === 'move' && moved.current) p.onDirty();
    if (drag?.kind === 'link') {
      const pt = local(e);
      const target = nodeAt(pt.x, pt.y);
      if (target && target.id !== drag.from) {
        const r = connect(p.graph, drag.from, target.id);
        if (r.error) p.onError(r.error);
        else p.onChange(r.graph);
      }
    }
    setDrag(null);
  }

  const edgePath = (e: GEdge) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return null;
    const x1 = pos(a).x + NODE_W;
    const y1 = pos(a).y + NODE_H / 2;
    const x2 = pos(b).x;
    const y2 = pos(b).y + NODE_H / 2;
    const c = Math.max(40, Math.abs(x2 - x1) / 2);
    return { d: `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  };

  return (
    <div className="builder-canvas">
      <svg
        ref={svg}
        width={w}
        height={h}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setDrag(null)}
        onPointerDown={(e) => e.target === svg.current && p.setSel(null)}
        role="application"
        aria-label={t('ariaGraph')}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
          </marker>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="var(--line)" />
          </pattern>
        </defs>
        <rect width={w} height={h} fill="url(#grid)" pointerEvents="none" />
        {p.graph.edges.map((e, i) => {
          const path = edgePath(e);
          if (!path) return null;
          const selected = p.sel?.kind === 'edge' && p.sel.index === i;
          return (
            <g key={`${e.from}-${e.to}-${i}`} className="edge" onPointerDown={(ev) => (ev.stopPropagation(), p.setSel({ kind: 'edge', index: i }))}>
              <path d={path.d} stroke="transparent" strokeWidth={14} fill="none" />
              <path d={path.d} stroke={selected ? 'var(--accent)' : 'var(--muted)'} strokeWidth={selected ? 2.5 : 1.5} fill="none" markerEnd="url(#arrow)" />
              {e.when && (
                <g transform={`translate(${path.mx},${path.my})`}>
                  <rect x={-20} y={-10} width={40} height={20} rx={10} fill="var(--bg)" stroke={e.when === 'true' ? 'var(--ok)' : 'var(--bad)'} />
                  <text textAnchor="middle" dy={4} fontSize={11} fill={e.when === 'true' ? 'var(--ok)' : 'var(--bad)'}>
                    {e.when}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {drag?.kind === 'link' && byId.get(drag.from) && (
          <line x1={pos(byId.get(drag.from)!).x + NODE_W} y1={pos(byId.get(drag.from)!).y + NODE_H / 2} x2={drag.x} y2={drag.y} stroke="var(--accent)" strokeDasharray="4 3" pointerEvents="none" />
        )}
        {p.graph.nodes.map((n) => {
          const { x, y } = pos(n);
          const selected = p.sel?.kind === 'node' && p.sel.id === n.id;
          const step = p.run?.steps[n.id];
          const stroke = step ? STEP_COLOR[step.status] ?? 'var(--muted)' : selected ? 'var(--accent)' : 'var(--line)';
          const label = n.label || p.typeInfo.get(n.type)?.label || n.type;
          return (
            <g
              key={n.id}
              transform={`translate(${x},${y})`}
              className="node"
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture?.(e.pointerId);
                moved.current = false;
                const pt = local(e);
                p.setSel({ kind: 'node', id: n.id });
                setDrag({ kind: 'move', id: n.id, dx: pt.x - x, dy: pt.y - y });
              }}
            >
              <rect width={NODE_W} height={NODE_H} rx={8} fill="var(--card)" stroke={stroke} strokeWidth={selected || step ? 2.5 : 1.5} strokeDasharray={step?.status === 'SKIPPED' ? '5 4' : undefined} />
              {n.type === TRIGGER && <rect width={6} height={NODE_H} rx={3} fill="var(--accent)" />}
              {n.type === IF && <rect width={6} height={NODE_H} rx={3} fill="var(--warn)" />}
              <text x={14} y={22} fontSize={13} fontWeight={600} fill="var(--fg)">
                {label.length > 24 ? `${label.slice(0, 23)}…` : label}
              </text>
              <text x={14} y={40} fontSize={11} fill="var(--muted)">
                {step ? `${n.id} · ${step.status}` : `${n.id} · ${n.type}`}
              </text>
              {n.type !== TRIGGER && <circle cx={0} cy={NODE_H / 2} r={5} fill="var(--bg)" stroke="var(--muted)" />}
              <circle
                className="port"
                cx={NODE_W}
                cy={NODE_H / 2}
                r={7}
                fill="var(--bg)"
                stroke="var(--accent)"
                strokeWidth={2}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture?.(e.pointerId);
                  const pt = local(e);
                  setDrag({ kind: 'link', from: n.id, x: pt.x, y: pt.y });
                }}
              >
                <title>{t('portTitle')}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <p className="muted small" style={{ margin: '4px 8px' }}>
        {t('hint')}
      </p>
    </div>
  );
}

/* ---------------- side panels ---------------- */
function Palette({ types, onAdd }: { types: NodeTypeInfo[]; onAdd: (t: NodeTypeInfo) => void }) {
  const tr = useT(M);
  const groups = new Map<string, NodeTypeInfo[]>();
  for (const t of types.filter((x) => x.type !== TRIGGER)) {
    const g = t.type.split('.')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  return (
    <>
      <h3>{tr('addStep')}</h3>
      <p className="muted small">{tr('paletteHelp')}</p>
      {[...groups].map(([g, items]) => (
        <div key={g} style={{ marginBottom: 8 }}>
          <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {g}
          </div>
          {items.map((t) => (
            <button key={t.type} className="palette-item" onClick={() => onAdd(t)}>
              + {t.label}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function NodePanel(p: {
  graph: Graph;
  node: GNode;
  info: NodeTypeInfo | undefined;
  step: Step | undefined;
  onChange: (g: Graph) => void;
  onSelect: (id: string | null) => void;
  onError: (t: string) => void;
}) {
  const t = useT(M);
  const n = p.node;
  const set =(patch: Partial<GNode>) => p.onChange(updateNode(p.graph, n.id, patch));
  return (
    <>
      <h3 style={{ marginBottom: 4 }}>{p.info?.label ?? n.type}</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>
        <code>{n.type}</code>
      </div>
      <div className="form">
        <label>
          {t('id')}
          <input
            defaultValue={n.id}
            onBlur={(e) => {
              const r = renameNode(p.graph, n.id, e.target.value.trim());
              if (r.error) {
                p.onError(r.error);
                e.target.value = n.id;
              } else if (r.graph !== p.graph) {
                p.onChange(r.graph);
                p.onSelect(e.target.value.trim());
              }
            }}
          />
        </label>
        <label>
          {t('labelOpt')}
          <input value={n.label ?? ''} maxLength={80} onChange={(e) => set({ label: e.target.value || undefined })} placeholder={p.info?.label} />
        </label>
        {p.info && Object.keys(p.info.configSchema.properties ?? {}).length > 0 && (
          <fieldset>
            <legend>{t('settings')}</legend>
            <ObjectFields schema={p.info.configSchema} value={n.config} onChange={(config) => set({ config })} />
          </fieldset>
        )}
        {n.type !== TRIGGER && (
          <>
            <label>
              {t('timeout')}
              <input type="number" min={10} max={3600} value={n.timeoutSeconds} onChange={(e) => set({ timeoutSeconds: Number(e.target.value) })} />
            </label>
            <label>
              {t('onError')}
              <select value={n.onError} onChange={(e) => set({ onError: e.target.value as 'stop' | 'continue' })}>
                <option value="stop">{t('errStop')}</option>
                <option value="continue">{t('errContinue')}</option>
              </select>
            </label>
          </>
        )}
      </div>
      {p.step && (
        <div className="small" style={{ marginTop: 12 }}>
          <b>{t('selectedRun')}</b> <Status s={p.step.status} />
          {p.step.startedAt && <div className="muted">{t('startedAt', { t: fmtTime(p.step.startedAt) })}</div>}
          {p.step.finishedAt && <div className="muted">{t('finishedAt', { t: fmtTime(p.step.finishedAt) })}</div>}
          {p.step.jobIds.length > 0 && <div className="muted">{t('jobs', { ids: p.step.jobIds.map((j) => j.slice(0, 8)).join(', ') })}</div>}
          {p.step.error && <div className="error-inline">{p.step.error}</div>}
          {p.step.result !== undefined && (
            <details>
              <summary>{t('result')}</summary>
              <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(p.step.result, null, 2).slice(0, 2000)}
              </pre>
            </details>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: 16 }}>
        {n.type !== TRIGGER && (
          <button
            onClick={() => {
              p.onChange(removeNode(p.graph, n.id));
              p.onSelect(null);
            }}
          >
            {t('deleteStep')}
          </button>
        )}
        <button onClick={() => p.onSelect(null)}>{t('done')}</button>
      </div>
    </>
  );
}

function EdgePanel({ graph, index, onChange, onDone }: { graph: Graph; index: number; onChange: (g: Graph) => void; onDone: () => void }) {
  const t = useT(M);
  const e = graph.edges[index]!;
  return (
    <>
      <h3>{t('connection')}</h3>
      <p>
        <code>{e.from}</code> → <code>{e.to}</code>
      </p>
      {e.when && (
        <p>
          {t('runsWhen')} <b className={e.when === 'true' ? 'ok-text' : 'error-inline'}>{e.when}</b>. <button onClick={() => onChange(toggleWhen(graph, index))}>{t('switchTo', { v: e.when === 'true' ? 'false' : 'true' })}</button>
        </p>
      )}
      <div className="row">
        <button
          onClick={() => {
            onChange(removeEdge(graph, index));
            onDone();
          }}
        >
          {t('deleteConnection')}
        </button>
        <button onClick={onDone}>{t('done')}</button>
      </div>
    </>
  );
}

/** Form fields generated from a node's JSON Schema (objects, enums, numbers, booleans, strings, string lists, number|string). */
function ObjectFields({ schema, value, onChange }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([k, s]) => (
        <Field
          key={k}
          name={k}
          schema={s}
          required={(schema.required ?? []).includes(k)}
          value={value[k]}
          onChange={(v) => {
            const next = { ...value };
            if (v === undefined) delete next[k];
            else next[k] = v;
            onChange(next);
          }}
        />
      ))}
    </>
  );
}

function Field({ name, schema: s, required, value, onChange }: { name: string; schema: JsonSchema; required: boolean; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT(M);
  const range = s.minimum !== undefined || s.maximum !== undefined ? ` (${s.minimum ?? ''}–${s.maximum ?? ''})` : '';
  const title = `${name}${range}${required ? '' : t('optional')}`;
  if (s.type === 'object' && s.properties)
    return (
      <fieldset>
        <legend>{name}</legend>
        <ObjectFields schema={s} value={(value as Record<string, unknown>) ?? {}} onChange={onChange} />
      </fieldset>
    );
  if (s.enum)
    return (
      <label>
        {title}
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
          {!required && <option value="">—</option>}
          {s.enum.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      </label>
    );
  if (s.type === 'boolean')
    return (
      <label className="check">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {name}
      </label>
    );
  if (s.type === 'integer' || s.type === 'number')
    return (
      <label>
        {title}
        <input type="number" min={s.minimum} max={s.maximum} step={s.type === 'integer' ? 1 : 'any'} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      </label>
    );
  if (s.type === 'array')
    return (
      <label>
        {title} — {t('commaSep')}
        <input
          defaultValue={Array.isArray(value) ? value.join(', ') : ''}
          onBlur={(e) => {
            const items = e.target.value
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
            onChange(items.length ? items : undefined);
          }}
        />
      </label>
    );
  if (s.anyOf)
    return (
      <label>
        {title} — {t('numOrText')}
        <input value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value.trim() !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value)} />
      </label>
    );
  const long = (s.maxLength ?? 0) > 200;
  return (
    <label>
      {title}
      {long ? (
        <textarea rows={4} maxLength={s.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input maxLength={s.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

/* ---------------- runs ---------------- */
function Runs({ runs, selected, onSelect, onCancel }: { runs: WorkflowRun[]; selected: string | null; onSelect: (id: string | null) => void; onCancel: (jobId: string) => void }) {
  const t = useT(M);
  return (
    <>
      <h3>{t('runs')}</h3>
      {runs.length === 0 ? (
        <Empty>{t('noRuns')}</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('colStarted')}</th>
              <th>{t('colVersion')}</th>
              <th>{t('colStatus')}</th>
              <th>{t('colSteps')}</th>
              <th>{t('colError')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const counts = Object.values(r.steps).reduce<Record<string, number>>((a, s) => ((a[s.status] = (a[s.status] ?? 0) + 1), a), {});
              return (
                <tr key={r.id} className={selected === r.id ? 'selected' : ''}>
                  <td className="small">{fmtTime(r.startedAt)}</td>
                  <td>v{r.version}</td>
                  <td>
                    <Status s={r.status} />
                  </td>
                  <td className="small">
                    {Object.entries(counts)
                      .map(([k, n]) => `${k} ${n}`)
                      .join(' · ')}
                  </td>
                  <td className="small">{r.error ?? ''}</td>
                  <td>
                    <button onClick={() => onSelect(selected === r.id ? null : r.id)}>{selected === r.id ? t('hideOnGraph') : t('showOnGraph')}</button>{' '}
                    {ACTIVE.includes(r.status) && r.jobId && <button onClick={() => onCancel(r.jobId!)}>{t('cancel')}</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
