#!/usr/bin/env node
/**
 * MCP SSH Persistent Server
 * Provides persistent SSH connections with streaming support for Claude Code
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { TOOLS } from './tools/definitions.js';
import { handleToolCall } from './tools/handlers.js';
import { errorResponse } from './utils/response.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

let config = {};
try {
  config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf8'));
} catch {
  // Use defaults if config not found
}

// ─────────────────────────────────────────────────────────────
// Graceful Shutdown (suppress errors on exit/restart)
// ─────────────────────────────────────────────────────────────

const exit0 = () => { try { process.exit(0); } catch {} };
process.stderr.write = () => true; // Suppress stderr to avoid "failed" message
process.on('SIGINT', exit0);
process.on('SIGTERM', exit0);
process.on('uncaughtException', exit0);
process.on('unhandledRejection', exit0);

// ─────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mcp-ssh-persistent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await handleToolCall(name, args, config);
  } catch (error) {
    return errorResponse(error.message);
  }
});

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
process.stdin.on('close', exit0);
server.connect(transport).catch(exit0);
