import { z } from 'zod';

/**
 * Workflow DAG definition (Master Plan §10.3, Phase 9). A versioned JSON graph of whitelisted node types; every
 * node maps to an existing, guarded job (no arbitrary code, no new collector logic). Validation rejects cycles,
 * unreachable nodes, unknown types, bad configs and unbounded waits — so a graph can never loop forever.
 */

const conditionSchema = z
  .object({
    metric: z.enum(['pendingCandidates', 'newPosts24h', 'viralLabeled', 'previousStatus']),
    op: z.enum(['>', '>=', '==', '<', '<=', '!=']),
    value: z.union([z.number(), z.string().max(40)]),
  })
  .strict();

export const NODE_CONFIG = {
  'trigger.manual': z.object({}).strict(),
  'collect.discover': z.object({ platforms: z.array(z.string().max(20)).max(10).optional() }).strict(),
  'collect.sync_tracked': z.object({ maxAccounts: z.number().int().min(1).max(200).default(50) }).strict(),
  'collect.metrics_refresh': z.object({}).strict(),
  'analytics.viral': z.object({}).strict(),
  'analytics.trends': z.object({ windowDays: z.number().int().min(1).max(90).default(7) }).strict(),
  'ai.analyze': z.object({}).strict(),
  'export.file': z.object({ format: z.enum(['xlsx', 'csv', 'json']).default('xlsx') }).strict(),
  'report.generate': z.object({ kind: z.enum(['daily', 'weekly']).default('daily'), notify: z.boolean().default(false) }).strict(),
  'notify.message': z.object({ title: z.string().min(1).max(200), body: z.string().max(2000).default('') }).strict(),
  'flow.wait': z.object({ seconds: z.number().int().min(1).max(3600) }).strict(),
  'flow.if': z.object({ condition: conditionSchema }).strict(),
} as const;
export type NodeType = keyof typeof NODE_CONFIG;
export const NODE_TYPES = Object.keys(NODE_CONFIG) as NodeType[];

export const NODE_LABELS: Record<NodeType, string> = {
  'trigger.manual': 'Start (manual / schedule)',
  'collect.discover': 'Discover accounts (keywords)',
  'collect.sync_tracked': 'Sync tracked accounts',
  'collect.metrics_refresh': 'Refresh post metrics',
  'analytics.viral': 'Viral scoring (policy-gated)',
  'analytics.trends': 'Trend detection (policy-gated)',
  'ai.analyze': 'AI analysis (policy-gated)',
  'export.file': 'Export file',
  'report.generate': 'Report',
  'notify.message': 'Send notification',
  'flow.wait': 'Wait',
  'flow.if': 'If (condition)',
};

export const graphSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
            type: z.enum(NODE_TYPES as [NodeType, ...NodeType[]]),
            label: z.string().max(80).optional(),
            config: z.record(z.string(), z.unknown()).default({}),
            timeoutSeconds: z.number().int().min(10).max(3600).default(900),
            onError: z.enum(['stop', 'continue']).default('stop'),
            position: z.object({ x: z.number(), y: z.number() }).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    edges: z
      .array(z.object({ from: z.string(), to: z.string(), when: z.enum(['true', 'false']).optional() }).strict())
      .max(100),
  })
  .strict();
export type Graph = z.infer<typeof graphSchema>;
export type GraphNode = Graph['nodes'][number];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  graph: Graph | null;
  order: string[];
}

export function validateGraph(input: unknown): ValidationResult {
  const parsed = graphSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), graph: null, order: [] };
  const g = parsed.data;
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) errors.push(`Duplicate node id "${n.id}"`);
    ids.add(n.id);
    const c = NODE_CONFIG[n.type].safeParse(n.config);
    if (!c.success) errors.push(`Node "${n.id}" (${n.type}) config: ${c.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
    else n.config = c.data as Record<string, unknown>;
  }
  for (const e of g.edges) {
    if (!ids.has(e.from)) errors.push(`Edge from unknown node "${e.from}"`);
    if (!ids.has(e.to)) errors.push(`Edge to unknown node "${e.to}"`);
    if (e.from === e.to) errors.push(`Self-loop on "${e.from}"`);
  }
  const triggers = g.nodes.filter((n) => n.type === 'trigger.manual');
  if (triggers.length !== 1) errors.push(`Exactly one trigger.manual node is required (found ${triggers.length})`);
  const incoming = (id: string) => g.edges.filter((e) => e.to === id);
  if (triggers[0] && incoming(triggers[0].id).length) errors.push('The trigger cannot have incoming edges');
  for (const n of g.nodes) {
    const out = g.edges.filter((e) => e.from === n.id);
    if (n.type === 'flow.if') {
      if (out.some((e) => !e.when)) errors.push(`Edges leaving if-node "${n.id}" need when: "true" or "false"`);
    } else if (out.some((e) => e.when)) errors.push(`Only if-nodes may have conditional edges ("${n.id}")`);
  }
  // Kahn topological sort → detects cycles (DAG only: loops cannot run forever).
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to)! + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of g.edges.filter((x) => x.from === id)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length !== g.nodes.length) errors.push('The graph has a cycle; workflows must be acyclic (use schedules to repeat)');
  // Reachability from the trigger.
  if (triggers[0] && order.length === g.nodes.length) {
    const reach = new Set([triggers[0].id]);
    for (const id of order) if (reach.has(id)) for (const e of g.edges.filter((x) => x.from === id)) reach.add(e.to);
    const orphan = g.nodes.filter((n) => !reach.has(n.id)).map((n) => n.id);
    if (orphan.length) errors.push(`Unreachable from the trigger: ${orphan.join(', ')}`);
  }
  const budget = g.nodes.reduce((a, n) => a + (n.type === 'flow.wait' ? Number((n.config as { seconds: number }).seconds) : 0), 0);
  if (budget > 3600) errors.push(`Total wait time ${budget}s exceeds 3600s`);
  return { ok: errors.length === 0, errors, graph: errors.length ? null : g, order: errors.length ? [] : order };
}

export function evaluateCondition(c: z.infer<typeof conditionSchema>, actual: number | string | null): boolean {
  if (actual === null) return false;
  const v = c.value;
  switch (c.op) {
    case '>':
      return Number(actual) > Number(v);
    case '>=':
      return Number(actual) >= Number(v);
    case '<':
      return Number(actual) < Number(v);
    case '<=':
      return Number(actual) <= Number(v);
    case '==':
      return String(actual) === String(v);
    case '!=':
      return String(actual) !== String(v);
  }
}

/** Starter template: weekly market scan. */
export const TEMPLATE_WEEKLY_SCAN: Graph = {
  nodes: [
    { id: 'start', type: 'trigger.manual', config: {}, timeoutSeconds: 900, onError: 'stop', position: { x: 40, y: 120 } },
    { id: 'discover', type: 'collect.discover', config: {}, timeoutSeconds: 1800, onError: 'continue', position: { x: 240, y: 40 } },
    { id: 'sync', type: 'collect.sync_tracked', config: { maxAccounts: 50 }, timeoutSeconds: 1800, onError: 'continue', position: { x: 240, y: 200 } },
    { id: 'viral', type: 'analytics.viral', config: {}, timeoutSeconds: 600, onError: 'continue', position: { x: 460, y: 200 } },
    { id: 'trends', type: 'analytics.trends', config: { windowDays: 7 }, timeoutSeconds: 600, onError: 'continue', position: { x: 660, y: 200 } },
    { id: 'has_candidates', type: 'flow.if', config: { condition: { metric: 'pendingCandidates', op: '>', value: 0 } }, timeoutSeconds: 900, onError: 'stop', position: { x: 460, y: 40 } },
    { id: 'tell', type: 'notify.message', config: { title: 'New competitor candidates to review', body: 'Discovery found candidates — open the project review queue.' }, timeoutSeconds: 120, onError: 'continue', position: { x: 660, y: 40 } },
    { id: 'report', type: 'report.generate', config: { kind: 'weekly', notify: true }, timeoutSeconds: 900, onError: 'stop', position: { x: 860, y: 120 } },
  ],
  edges: [
    { from: 'start', to: 'discover' },
    { from: 'start', to: 'sync' },
    { from: 'sync', to: 'viral' },
    { from: 'viral', to: 'trends' },
    { from: 'discover', to: 'has_candidates' },
    { from: 'has_candidates', to: 'tell', when: 'true' },
    { from: 'trends', to: 'report' },
  ],
};
