#!/usr/bin/env node
/**
 * MCP SSH Persistent Server
 * Provides persistent SSH connections with streaming support for Claude Code
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { getToolDefinitions } from './tools/definitions.js';
import { createHandlers } from './tools/handlers.js';
import { createSessionPool } from './ssh/session-pool.js';
import { errorResponse } from './utils/response.js';
import { log } from './utils/logger.js';

// One pool for the process: alias -> lazily connected session (config.json servers).
const pool = createSessionPool();
const handleToolCall = createHandlers(pool);

// ─────────────────────────────────────────────────────────────
// Process handling (D9)
// stderr stays suppressed (MCP clients show it as noise / "failed");
// diagnostics go to logs/mcp-ssh.log instead.
// ─────────────────────────────────────────────────────────────

let exiting = false;
/** Graceful exit for client-initiated shutdown (signals / stdin closed). */
const gracefulExit = (reason) => {
  if (exiting) return;
  exiting = true;
  log('info', `shutdown: ${reason}`);
  try { pool.disconnect(); } catch {}
  try { process.exit(0); } catch {}
};

process.stderr.write = () => true;
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
// A stray rejected promise (e.g. late ssh2 error) must not kill every session.
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', reason instanceof Error ? reason : { reason: String(reason) });
});
// Unknown synchronous state after an uncaught exception: log and exit non-zero.
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', err);
  try { process.exit(1); } catch {}
});

// ─────────────────────────────────────────────────────────────
// MCP Server
// ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mcp-ssh-persistent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Built per request so the `server` param lists the aliases currently in config.
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolDefinitions() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await handleToolCall(name, args);
  } catch (error) {
    const message = error?.message || String(error);
    log('error', `tool ${name} failed`, { error: message });
    return errorResponse(message);
  }
});

// ─────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
process.stdin.on('close', () => gracefulExit('stdin closed'));
process.stdin.on('end', () => gracefulExit('stdin ended'));
server.connect(transport).catch((err) => {
  log('error', 'MCP transport connect failed', err);
  try { process.exit(1); } catch {}
});
