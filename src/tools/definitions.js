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
        sudo: {
          type: 'boolean',
          description: 'Run as root via sudo using the password stored in the OS credential store (Windows Credential Manager / macOS Keychain / Linux Secret Service) for the server user from config (never pass a password yourself). Runs bash -c on the remote (bash required); command stdin is EOF; not allowed for root users or with pty:true.',
        },
      }, ['server', 'command']),
    },
    {
      name: 'ssh_stream_start',
      description: 'Open a stateful interactive shell (own channel, history disabled) on a server, bound to stream_id; later stream calls use stream_id only. Optional command runs like ssh_stream_write but waits only 2000 ms by default, so long-running commands (tail -f, pm2 logs) return early with [state: timeout]. stream_id must be unique across servers; max 4 streams per server by default.',
      inputSchema: schema({
        server,
        stream_id: { type: 'string', description: 'Unique ID for this stream' },
        command: { type: 'string', description: 'Optional first command (newline appended)' },
        wait_ms: { type: 'number', description: 'Max wait for the first command in ms (default 2000)' },
      }, ['server', 'stream_id']),
    },
    {
      name: 'ssh_stream_read',
      description: 'Read buffered output of a stream since the last read/write. Footer [state: ...] shows prompt / awaiting_input(kind) / running.',
      inputSchema: schema({
        stream_id: { type: 'string', description: 'Stream ID to read from' },
        clear: { type: 'boolean', description: 'Clear buffer after read (default true)' },
        wait_ms: { type: 'number', description: 'Wait up to N ms for new output, returning after 500 ms of quiet (default 0)' },
      }, ['stream_id']),
    },
    {
      name: 'ssh_stream_write',
      description: 'Write data verbatim to a stream shell (include a real newline to press Enter) and wait until the command finishes (shell prompt), an input prompt appears, or wait_ms elapses. Footer: [state: prompt | awaiting_input(sudo|password|confirm) | timeout]; timeout means the command may still run (use ssh_stream_read). Unread output from before the write is reported, not silently dropped.',
      inputSchema: schema({
        stream_id: { type: 'string', description: 'Stream ID (selects the server shell)' },
        data: { type: 'string', description: 'Data to write, sent as-is; end with a newline character to press Enter' },
        wait_ms: { type: 'number', description: 'Max wait for completion in ms (default 5000; 0 = do not wait)' },
      }, ['stream_id', 'data']),
    },
    {
      name: 'ssh_sudo_auth',
      description: 'Answer a pending sudo password prompt in a stream with the password stored in the OS credential store (Windows Credential Manager / macOS Keychain / Linux Secret Service); never pass it yourself. Only acts when the stream shows exactly "[sudo] password for <server user>:" or the sudo-rs prompt "[sudo: authenticate] Password:" (state awaiting_input(sudo)); other prompts (ssh, su, mysql, Password:) are refused and nothing is sent. Call it right after a command you typed that starts with sudo. Waits like ssh_stream_write.',
      inputSchema: schema({
        stream_id: { type: 'string', description: 'Stream ID showing awaiting_input(sudo)' },
        wait_ms: { type: 'number', description: 'Max wait for completion after sending in ms (default 5000)' },
      }, ['stream_id']),
    },
    {
      name: 'ssh_stream_stop',
      description: 'Stop one stream: sends Ctrl+C, then closes only the shell channel of that stream.',
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
      description: 'Upload a local file to a server via SFTP (parallel fastPut). local_path must lie under os.tmpdir() or a configured localPathRoots dir; key dirs, ~/.ssh, ~/.claude, the MCP server repo/config and any .claude/.git dir, .mcp.json or CLAUDE.md are always refused. Returns one line: path, bytes, ms.',
      inputSchema: schema({
        server,
        local_path: { type: 'string', description: 'Local file path to upload' },
        remote_path: { type: 'string', description: 'Remote destination (file path, or directory ending with /)' },
      }, ['server', 'local_path', 'remote_path']),
    },
    {
      name: 'ssh_download',
      description: 'Download a remote file via SFTP (parallel fastGet to a .part file, then renamed over the target: no half files). Same local path policy as ssh_upload. Returns one line: path, bytes, ms.',
      inputSchema: schema({
        server,
        remote_path: { type: 'string', description: 'Remote file path to download' },
        local_path: { type: 'string', description: 'Local destination (file path, or directory ending with / or \\)' },
      }, ['server', 'remote_path', 'local_path']),
    },
    {
      name: 'ssh_write_remote_file',
      description: 'Write content to a remote file via SFTP (no shell escaping). Atomic: writes a temp file in the same dir, keeps the existing file mode/owner, then renames over the target. Falls back to an in-place write (with a warning) when the dir is not writable.',
      inputSchema: schema({
        server,
        remote_path: { type: 'string', description: 'Remote file path to write' },
        content: { type: 'string', description: 'File content (UTF-8 text)' },
        mode: { type: 'string', description: 'Optional octal mode, e.g. "600" (default: existing file mode, else 644)' },
      }, ['server', 'remote_path', 'content']),
    },
    {
      name: 'ssh_read_remote_file',
      description: 'Read a remote text file via SFTP. Returns "# <path> (<bytes> bytes)" then the raw content. Files above limits.maxReadFileBytes (default 2 MB) or binary files are refused (use ssh_exec with head/tail/sed -n, or ssh_download).',
      inputSchema: schema({
        server,
        remote_path: { type: 'string', description: 'Remote file path to read' },
      }, ['server', 'remote_path']),
    },
  ];
}
