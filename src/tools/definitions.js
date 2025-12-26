/**
 * MCP Tool Definitions
 * JSON schemas for all SSH tools
 */

export const TOOLS = [
  {
    name: 'ssh_connect',
    description: 'Connect to SSH server and establish persistent session. Connection persists across calls.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'SSH host (default from config)' },
        port: { type: 'number', description: 'SSH port (default: 22)' },
        username: { type: 'string', description: 'Username (default from config)' },
        privateKeyPath: { type: 'string', description: 'Path to private key (default from config)' },
        password: { type: 'string', description: 'Password (if not using key)' },
      },
      required: [],
    },
  },
  {
    name: 'ssh_exec',
    description: 'Execute command via SSH exec channel with PTY. Returns output with exit code. Each command runs in fresh environment (stateless). Use ssh_stream_* for stateful/interactive commands.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'ssh_stream_start',
    description: 'Start streaming command (e.g., tail -f, pm2 logs). Use ssh_stream_read to get output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Streaming command to run' },
        stream_id: { type: 'string', description: 'Unique ID for this stream' },
      },
      required: ['command', 'stream_id'],
    },
  },
  {
    name: 'ssh_stream_read',
    description: 'Read output from active stream. Returns buffered output since last read. Use wait_ms after sending input to wait for response.',
    inputSchema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'Stream ID to read from' },
        clear: { type: 'boolean', description: 'Clear buffer after read (default: true)' },
        wait_ms: { type: 'number', description: 'Wait up to N ms for new output (default: 0). Use 2000-5000 after password/input.' },
      },
      required: ['stream_id'],
    },
  },
  {
    name: 'ssh_stream_write',
    description: 'Write input to stream with optional auto-read. Polls for output until prompt detected or timeout. Returns output immediately without needing separate ssh_stream_read call.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data to write to stream (add \\n for enter)' },
        wait_ms: { type: 'number', description: 'Max wait time in ms for output (default: 5000). Set to 0 for no wait (old behavior).' },
        poll_interval: { type: 'number', description: 'Poll interval in ms (default: 100).' },
      },
      required: ['data'],
    },
  },
  {
    name: 'ssh_stream_stop',
    description: 'Stop streaming command (sends Ctrl+C) and cleanup.',
    inputSchema: {
      type: 'object',
      properties: {
        stream_id: { type: 'string', description: 'Stream ID to stop' },
      },
      required: ['stream_id'],
    },
  },
  {
    name: 'ssh_status',
    description: 'Get SSH connection status and info.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'ssh_disconnect',
    description: 'Disconnect SSH session.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'ssh_reset_shell',
    description: 'Reset shell state - closes current shell and clears all streams. Use when shell becomes unresponsive.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'ssh_upload',
    description: 'Upload file from local to remote server via SFTP.',
    inputSchema: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'Local file path to upload' },
        remote_path: { type: 'string', description: 'Remote destination path (file path or directory ending with /)' },
      },
      required: ['local_path', 'remote_path'],
    },
  },
  {
    name: 'ssh_download',
    description: 'Download file from remote server to local via SFTP.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_path: { type: 'string', description: 'Remote file path to download' },
        local_path: { type: 'string', description: 'Local destination path (file path or directory ending with / or \\)' },
      },
      required: ['remote_path', 'local_path'],
    },
  },
  {
    name: 'ssh_write_remote_file',
    description: 'Write content directly to remote file via SFTP. Useful for creating/editing files without shell escaping issues.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_path: { type: 'string', description: 'Remote file path to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['remote_path', 'content'],
    },
  },
  {
    name: 'ssh_read_remote_file',
    description: 'Read remote file content directly via SFTP. Returns file content without shell escaping issues.',
    inputSchema: {
      type: 'object',
      properties: {
        remote_path: { type: 'string', description: 'Remote file path to read' },
      },
      required: ['remote_path'],
    },
  },
];
