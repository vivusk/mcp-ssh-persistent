/**
 * MCP tool definitions
 * Built at ListTools time so the `server` parameter lists the aliases
 * currently configured in config.json.
 */
import { listServerAliases } from '../config/load-config-and-server-aliases.js';

/** Current alias names; a broken config yields [] (the call itself reports the error). */
function safeAliases() {
  try {
    return listServerAliases();
  } catch {
    return [];
  }
}

/** Schema for the required `server` alias parameter. */
function serverParam(aliases) {
  const list = aliases.length ? aliases.join(', ') : '(none configured)';
  return {
    type: 'string',
    description: `Server alias from config.json (case-insensitive). Known aliases: ${list}`,
  };
}

/** Shorthand for an object schema. */
const schema = (properties, required = []) => ({ type: 'object', properties, required });

/**
 * @param {string[]} [aliases] - Alias list (defaults to config)
 * @returns {Array<object>} MCP tool definitions
 */
export function getToolDefinitions(aliases = safeAliases()) {
  const server = serverParam(aliases);
  return [
    {
      name: 'ssh_exec',
      description: 'Run a command on a server via an exec channel (stateless, fresh environment per call; connects lazily). Returns stdout, a "--- stderr ---" section only when stderr is non-empty, and [exit: N]. Output is capped (head+tail kept). Exit 1 is not flagged as an error. Use ssh_stream_* for stateful/interactive work.',
      inputSchema: schema({
        server,
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
        pty: { type: 'boolean', description: 'Allocate a PTY (default false; stderr is merged into stdout when true)' },
      }, ['server', 'command']),
    },
    {
      name: 'ssh_stream_start',
      description: 'Start an interactive/streaming shell command on a server (e.g. tail -f, pm2 logs). The stream_id is bound to that server; later stream calls use stream_id only.',
      inputSchema: schema({
        server,
        stream_id: { type: 'string', description: 'Unique ID for this stream' },
        command: { type: 'string', description: 'Command to run in the shell' },
      }, ['server', 'stream_id', 'command']),
    },
    {
      name: 'ssh_stream_read',
      description: 'Read buffered output of a stream since the last read.',
      inputSchema: schema({
        stream_id: { type: 'string', description: 'Stream ID to read from' },
        clear: { type: 'boolean', description: 'Clear buffer after read (default true)' },
        wait_ms: { type: 'number', description: 'Wait up to N ms for new output (default 0)' },
      }, ['stream_id']),
    },
    {
      name: 'ssh_stream_write',
      description: 'Write input to the shell of a stream and auto-read output until a prompt is detected or wait_ms elapses.',
      inputSchema: schema({
        stream_id: { type: 'string', description: 'Stream ID (selects the server shell)' },
        data: { type: 'string', description: 'Data to write (add \\n for enter)' },
        wait_ms: { type: 'number', description: 'Max wait for output in ms (default 5000; 0 = no wait)' },
        poll_interval: { type: 'number', description: 'Poll interval in ms (default 100)' },
      }, ['stream_id', 'data']),
    },
    {
      name: 'ssh_stream_stop',
      description: 'Stop a stream (sends Ctrl+C) and clean up.',
      inputSchema: schema({ stream_id: { type: 'string', description: 'Stream ID to stop' } }, ['stream_id']),
    },
    {
      name: 'ssh_status',
      description: 'Status of pooled SSH sessions (alias, host, user, connected, host-key fingerprint, streams).',
      inputSchema: schema({}),
    },
    {
      name: 'ssh_disconnect',
      description: 'Disconnect one server session, or all sessions when server is omitted.',
      inputSchema: schema({ server: { ...server, description: `${server.description}. Omit to disconnect all.` } }),
    },
    {
      name: 'ssh_upload',
      description: 'Upload a local file to a server via SFTP.',
      inputSchema: schema({
        server,
        local_path: { type: 'string', description: 'Local file path to upload' },
        remote_path: { type: 'string', description: 'Remote destination (file path, or directory ending with /)' },
      }, ['server', 'local_path', 'remote_path']),
    },
    {
      name: 'ssh_download',
      description: 'Download a remote file to local via SFTP.',
      inputSchema: schema({
        server,
        remote_path: { type: 'string', description: 'Remote file path to download' },
        local_path: { type: 'string', description: 'Local destination (file path, or directory ending with / or \\)' },
      }, ['server', 'remote_path', 'local_path']),
    },
    {
      name: 'ssh_write_remote_file',
      description: 'Write content directly to a remote file via SFTP (no shell escaping).',
      inputSchema: schema({
        server,
        remote_path: { type: 'string', description: 'Remote file path to write' },
        content: { type: 'string', description: 'File content' },
      }, ['server', 'remote_path', 'content']),
    },
    {
      name: 'ssh_read_remote_file',
      description: 'Read a remote file via SFTP.',
      inputSchema: schema({
        server,
        remote_path: { type: 'string', description: 'Remote file path to read' },
      }, ['server', 'remote_path']),
    },
  ];
}
