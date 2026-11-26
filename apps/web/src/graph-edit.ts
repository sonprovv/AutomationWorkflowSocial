/*
 * Pure graph-editing helpers for the workflow builder (Phase 9, P9-02). The server (`validateGraph`) stays the
 * source of truth; these helpers only keep obvious mistakes out of the editor (self-loops, duplicate edges,
 * cycles, edges into the trigger) and never mutate their input.
 */

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  anyOf?: JsonSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
}

export interface NodeTypeInfo {
  type: string;
  label: string;
  configSchema: JsonSchema;
}

export interface GNode {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
  timeoutSeconds: number;
  onError: 'stop' | 'continue';
  position?: { x: number; y: number };
}
export interface GEdge {
  from: string;
  to: string;
  when?: 'true' | 'false';
}
export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

export const TRIGGER = 'trigger.manual';
export const IF = 'flow.if';
export const NODE_ID_RE = /^[a-z0-9_-]{1,40}$/;
export const NODE_W = 190;
/** Horizontal distance between columns (leaves room for edge labels). */
export const COL_GAP = 240;
export const NODE_H = 56;

/** A valid starting value for a config schema: declared defaults, else the smallest valid value. */
export function defaultFromSchema(s: JsonSchema): unknown {
  if (s.default !== undefined) return structuredClone(s.default);
  if (s.enum?.length) return s.enum[0];
  if (s.anyOf?.length) return defaultFromSchema(s.anyOf[0]!);
  switch (s.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) {
        const p = s.properties?.[k];
        if (p) out[k] = defaultFromSchema(p);
      }
      return out;
    }
    case 'integer':
    case 'number':
      return s.minimum !== undefined && s.minimum > 0 ? Math.max(s.minimum, Math.min(60, s.maximum ?? 60)) : 0;
    case 'boolean':
      return false;
    case 'string':
      return s.minLength && s.minLength > 0 ? 'Untitled' : '';
    case 'array':
      return [];
    default:
      return null;
  }
}

/** `discover`, `discover_2`, … — ids must match NODE_ID_RE and be unique. */
export function uniqueId(g: Graph, type: string): string {
  const base = (type.split('.').pop() ?? 'node').toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 34) || 'node';
  const taken = new Set(g.nodes.map((n) => n.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** First free grid slot to the right of the existing nodes. */
export function freePosition(g: Graph): { x: number; y: number } {
  if (!g.nodes.length) return { x: 40, y: 40 };
  const maxX = Math.max(...g.nodes.map((n) => n.position?.x ?? 40));
  const col = g.nodes.filter((n) => (n.position?.x ?? 40) === maxX);
  const y = Math.max(...col.map((n) => n.position?.y ?? 40)) + 100;
  return y > 440 ? { x: maxX + COL_GAP, y: 40 } : { x: maxX, y };
}

export function addNode(g: Graph, info: NodeTypeInfo, position = freePosition(g)): { graph: Graph; id: string } {
  const id = uniqueId(g, info.type);
  const node: GNode = {
    id,
    type: info.type,
    config: (defaultFromSchema(info.configSchema) as Record<string, unknown>) ?? {},
    timeoutSeconds: info.type === 'notify.message' ? 120 : 900,
    onError: 'stop',
    position,
  };
  return { graph: { nodes: [...g.nodes, node], edges: g.edges }, id };
}

export function removeNode(g: Graph, id: string): Graph {
  return { nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) };
}

export function removeEdge(g: Graph, index: number): Graph {
  return { nodes: g.nodes, edges: g.edges.filter((_, i) => i !== index) };
}

export function updateNode(g: Graph, id: string, patch: Partial<GNode>): Graph {
  return { nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)), edges: g.edges };
}

/** True when `to` can already reach `from` (so from → to would close a cycle). */
function reaches(g: Graph, start: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

export function connect(g: Graph, from: string, to: string): { graph: Graph; error?: string } {
  const a = g.nodes.find((n) => n.id === from);
  const b = g.nodes.find((n) => n.id === to);
  if (!a || !b) return { graph: g, error: 'Unknown node' };
  if (from === to) return { graph: g, error: 'A node cannot connect to itself' };
  if (b.type === TRIGGER) return { graph: g, error: 'The start node cannot have incoming edges' };
  if (g.edges.some((e) => e.from === from && e.to === to)) return { graph: g, error: 'These nodes are already connected' };
  if (reaches(g, to, from)) return { graph: g, error: 'That edge would create a cycle; workflows must be acyclic' };
  const edge: GEdge = { from, to };
  if (a.type === IF) edge.when = g.edges.some((e) => e.from === from && e.when === 'true') ? 'false' : 'true';
  return { graph: { nodes: g.nodes, edges: [...g.edges, edge] } };
}

export function toggleWhen(g: Graph, index: number): Graph {
  return { nodes: g.nodes, edges: g.edges.map((e, i) => (i === index && e.when ? { ...e, when: e.when === 'true' ? 'false' : 'true' } : e)) };
}

export function renameNode(g: Graph, oldId: string, newId: string): { graph: Graph; error?: string } {
  if (oldId === newId) return { graph: g };
  if (!NODE_ID_RE.test(newId)) return { graph: g, error: 'Ids use a–z, 0–9, "_" or "-" (1–40 characters)' };
  if (g.nodes.some((n) => n.id === newId)) return { graph: g, error: `Id "${newId}" is already used` };
  const swap = (id: string) => (id === oldId ? newId : id);
  return {
    graph: {
      nodes: g.nodes.map((n) => (n.id === oldId ? { ...n, id: newId } : n)),
      edges: g.edges.map((e) => ({ ...e, from: swap(e.from), to: swap(e.to) })),
    },
  };
}

/** Columns by longest path from the roots; used for graphs saved without positions. Cycles fall back to column 0. */
export function autoLayout(g: Graph): Graph {
  const depth = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < g.nodes.length; pass++) {
    let changed = false;
    for (const e of g.edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (depth.has(e.to) && d > depth.get(e.to)! && d < g.nodes.length) {
        depth.set(e.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  return {
    nodes: g.nodes.map((n) => {
      const d = depth.get(n.id) ?? 0;
      const r = rows.get(d) ?? 0;
      rows.set(d, r + 1);
      return { ...n, position: { x: 40 + d * COL_GAP, y: 40 + r * 100 } };
    }),
    edges: g.edges,
  };
}

/** Ensure every node has a position (older graphs or API-created ones may lack them). */
export function withPositions(g: Graph): Graph {
  return g.nodes.every((n) => n.position) ? g : autoLayout(g);
}

/** Canvas size that fits every node plus a margin. */
export function canvasSize(g: Graph): { w: number; h: number } {
  const xs = g.nodes.map((n) => (n.position?.x ?? 0) + NODE_W);
  const ys = g.nodes.map((n) => (n.position?.y ?? 0) + NODE_H);
  return { w: Math.max(900, ...xs) + 80, h: Math.max(360, ...ys) + 80 };
}
