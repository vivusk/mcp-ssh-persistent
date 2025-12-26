/**
 * MCP Tool Handlers
 * Maps tool names to their implementations
 */
import { sshManager } from '../ssh/manager.js';
import { jsonResponse, textResponse, errorResponse, execResponse } from '../utils/response.js';

/**
 * Handle tool calls
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @param {object} config - Default config from config.json
 * @returns {Promise<object>} MCP response
 */
export async function handleToolCall(name, args, config) {
  switch (name) {
    case 'ssh_connect':
      return handleConnect(args, config);

    case 'ssh_exec':
      return handleExec(args);

    case 'ssh_stream_start':
      return handleStreamStart(args);

    case 'ssh_stream_read':
      return handleStreamRead(args);

    case 'ssh_stream_write':
      return handleStreamWrite(args);

    case 'ssh_stream_stop':
      return handleStreamStop(args);

    case 'ssh_status':
      return jsonResponse(sshManager.getStatus());

    case 'ssh_disconnect':
      return jsonResponse(sshManager.disconnect());

    case 'ssh_reset_shell':
      return jsonResponse(sshManager.resetShell());

    case 'ssh_upload':
      return handleUpload(args);

    case 'ssh_download':
      return handleDownload(args);

    case 'ssh_write_remote_file':
      return handleWriteRemoteFile(args);

    case 'ssh_read_remote_file':
      return handleReadRemoteFile(args);

    default:
      return errorResponse(`Unknown tool: ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Handler Implementations
// ─────────────────────────────────────────────────────────────

async function handleConnect(args, config) {
  const connectConfig = {
    host: args.host || config.host,
    port: args.port || config.port || 22,
    username: args.username || config.username,
    privateKeyPath: args.privateKeyPath || config.privateKeyPath,
    password: args.password || config.password,
  };

  if (!connectConfig.host || !connectConfig.username) {
    return errorResponse('host and username required');
  }

  const result = await sshManager.connect(connectConfig);
  return jsonResponse(result);
}

async function handleExec(args) {
  const timeout = args.timeout || 30000;
  const result = await sshManager.execCommand(args.command, timeout);
  return execResponse(result, timeout);
}

async function handleStreamStart(args) {
  const result = await sshManager.execStream(args.stream_id, args.command);
  return jsonResponse(result);
}

async function handleStreamRead(args) {
  const result = await sshManager.readStream(
    args.stream_id,
    args.clear !== false,
    args.wait_ms || 0
  );
  return textResponse(result.buffer || '(no new output)');
}

async function handleStreamWrite(args) {
  // Convert escaped \n to actual newline
  const data = args.data.replace(/\\n/g, '\n');
  const options = {
    wait_ms: args.wait_ms ?? 5000,  // Default 5s auto-read
    poll_interval: args.poll_interval ?? 100
  };
  const result = await sshManager.writeToShell(data, options);

  // If we got output, return it as text for better readability
  if (result.output) {
    return textResponse(
      `${result.output}\n---\n[complete: ${result.complete}]`
    );
  }
  return jsonResponse(result);
}

async function handleStreamStop(args) {
  sshManager.sendCtrlC();
  const result = sshManager.stopStream(args.stream_id);
  return jsonResponse(result);
}

async function handleUpload(args) {
  const result = await sshManager.scpUpload(args.local_path, args.remote_path);
  return jsonResponse(result);
}

async function handleDownload(args) {
  const result = await sshManager.scpDownload(args.remote_path, args.local_path);
  return jsonResponse(result);
}

async function handleWriteRemoteFile(args) {
  const result = await sshManager.writeRemoteFile(args.remote_path, args.content);
  return jsonResponse(result);
}

async function handleReadRemoteFile(args) {
  const result = await sshManager.readRemoteFile(args.remote_path);
  return jsonResponse(result);
}
