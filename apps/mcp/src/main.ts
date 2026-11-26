#!/usr/bin/env node
/**
 * Stdio MCP server for agents (Claude Desktop / Claude Code / any MCP client). Start the app first (start.bat),
 * then register:  command = node, args = [<repo>/node_modules/tsx/dist/cli.mjs, <repo>/apps/mcp/src/main.ts]
 * (see docs/MCP.md). Logs go to stderr — stdout carries the protocol.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '@sss/config';
import { createMcpServer } from './server.ts';

const config = loadConfig();
const apiBase = config.MCP_API_URL ?? `http://127.0.0.1:${config.APP_PORT}`;
const server = createMcpServer({ apiBase, allowMutations: config.MCP_ALLOW_MUTATIONS });
await server.connect(new StdioServerTransport());
console.error(`[mcp] social-spy-automation MCP server on stdio → ${apiBase} (mutations ${config.MCP_ALLOW_MUTATIONS ? 'ALLOWED' : 'disabled'})`);
