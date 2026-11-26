/** Phase 9 (P9-02): pure editing helpers behind the workflow builder canvas. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NODE_CONFIG, NODE_LABELS, NODE_TYPES, TEMPLATE_WEEKLY_SCAN, validateGraph } from '@sss/services';
import { addNode, autoLayout, connect, defaultFromSchema, removeNode, renameNode, toggleWhen, uniqueId, withPositions, type Graph, type JsonSchema, type NodeTypeInfo } from '../src/graph-edit.ts';

// Same shape as GET /workflow-defs/node-types.
const TYPES: NodeTypeInfo[] = NODE_TYPES.map((t) => ({ type: t, label: NODE_LABELS[t], configSchema: z.toJSONSchema(NODE_CONFIG[t]) as JsonSchema }));
const info = (t: string) => TYPES.find((x) => x.type === t)!;
const start: Graph = { nodes: [{ id: 'start', type: 'trigger.manual', config: {}, timeoutSeconds: 900, onError: 'stop', position: { x: 40, y: 40 } }], edges: [] };

describe('graph-edit', () => {
  it('builds a valid default config for every node type', () => {
    let g = start;
    for (const t of TYPES.filter((x) => x.type !== 'trigger.manual')) {
      const r = addNode(g, t);
      g = connect(r.graph, 'start', r.id).graph;
    }
    const v = validateGraph(g);
    expect(v.errors).toEqual([]);
    expect(defaultFromSchema(info('flow.if').configSchema)).toEqual({ condition: { metric: 'pendingCandidates', op: '>', value: 0 } });
    expect(defaultFromSchema(info('flow.wait').configSchema)).toEqual({ seconds: 60 });
  });

  it('gives unique ids and keeps the input graph unchanged', () => {
    const a = addNode(start, info('analytics.viral'));
    const b = addNode(a.graph, info('analytics.viral'));
    expect([a.id, b.id]).toEqual(['viral', 'viral_2']);
    expect(start.nodes).toHaveLength(1);
    expect(uniqueId(b.graph, 'analytics.viral')).toBe('viral_3');
  });

  it('refuses self-loops, edges into the trigger, duplicates and cycles', () => {
    let g = addNode(start, info('analytics.viral')).graph;
    g = addNode(g, info('analytics.trends')).graph;
    g = connect(g, 'start', 'viral').graph;
    g = connect(g, 'viral', 'trends').graph;
    expect(connect(g, 'viral', 'viral').error).toMatch(/itself/);
    expect(connect(g, 'viral', 'start').error).toMatch(/start node/);
    expect(connect(g, 'viral', 'trends').error).toMatch(/already/);
    expect(connect(g, 'trends', 'viral').error).toMatch(/cycle/);
    expect(validateGraph(g).ok).toBe(true);
  });

  it('labels if-branches true then false, and toggles them', () => {
    let g = addNode(start, info('flow.if')).graph;
    g = addNode(g, info('analytics.viral')).graph;
    g = addNode(g, info('analytics.trends')).graph;
    g = connect(g, 'start', 'if').graph;
    g = connect(g, 'if', 'viral').graph;
    g = connect(g, 'if', 'trends').graph;
    expect(g.edges.filter((e) => e.from === 'if').map((e) => e.when)).toEqual(['true', 'false']);
    expect(validateGraph(g).ok).toBe(true);
    expect(toggleWhen(g, 2).edges[2]!.when).toBe('true'); // edges: start→if, if→viral (true), if→trends (false)
  });

  it('renames a node with its edges and removes nodes with their edges', () => {
    let g = connect(addNode(start, info('analytics.viral')).graph, 'start', 'viral').graph;
    expect(renameNode(g, 'viral', 'Bad Id').error).toBeTruthy();
    expect(renameNode(g, 'viral', 'start').error).toMatch(/already/);
    g = renameNode(g, 'viral', 'score').graph;
    expect(g.edges).toEqual([{ from: 'start', to: 'score' }]);
    expect(removeNode(g, 'score')).toEqual({ nodes: start.nodes, edges: [] });
  });

  it('lays out graphs without positions by depth', () => {
    const bare: Graph = { nodes: TEMPLATE_WEEKLY_SCAN.nodes.map(({ position: _p, ...n }) => n), edges: TEMPLATE_WEEKLY_SCAN.edges };
    const laid = withPositions(bare);
    const x = (id: string) => laid.nodes.find((n) => n.id === id)!.position!.x;
    expect(x('start')).toBeLessThan(x('sync'));
    expect(x('sync')).toBeLessThan(x('viral'));
    expect(x('trends')).toBeLessThan(x('report'));
    expect(withPositions(TEMPLATE_WEEKLY_SCAN)).toBe(TEMPLATE_WEEKLY_SCAN);
    expect(autoLayout(laid).nodes.every((n) => n.position)).toBe(true);
  });
});
