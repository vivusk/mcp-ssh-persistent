# mcp-ssh-persistent

MCP server for persistent SSH connections with streaming support for Claude Code.

## Features

- **Persistent Connections** - Connect once, run multiple commands
- **Dual Channel Support**
  - `ssh_exec` - Stateless commands with exit codes
  - `ssh_stream_*` - Stateful interactive sessions
- **Auto-Read Output** - `ssh_stream_write` returns output immediately
- **SFTP Support** - Upload/download files directly
- **Prompt Detection** - Auto-detects command completion

## Requirements

- Node.js >= 18
- Claude Code CLI or Claude Desktop

## Installation

### Option 1: npx (Recommended)

No installation needed - just configure and use.

### Option 2: Global Install

```bash
npm install -g mcp-ssh-persistent
```

## Configuration

### Claude Code CLI

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-ssh-persistent"]
    }
  }
}
```

### Claude Desktop (macOS)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-ssh-persistent"]
    }
  }
}
```

### Claude Desktop (Windows)

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-ssh-persistent"]
    }
  }
}
```

### VS Code with Claude Extension

Add to VS Code settings (`Ctrl+,` → search "claude mcp"):

```json
{
  "claude.mcpServers": {
    "ssh": {
      "command": "npx",
      "args": ["-y", "mcp-ssh-persistent"]
    }
  }
}
```

After configuration, restart Claude Code/Desktop to load the MCP server.

## Tools

| Tool | Description |
|------|-------------|
| `ssh_connect` | Connect to SSH server |
| `ssh_exec` | Execute command (returns exit code) |
| `ssh_stream_start` | Start interactive shell |
| `ssh_stream_write` | Write + auto-read output |
| `ssh_stream_read` | Read stream buffer |
| `ssh_stream_stop` | Stop stream |
| `ssh_upload` | Upload file via SFTP |
| `ssh_download` | Download file via SFTP |
| `ssh_write_remote_file` | Write to remote file |
| `ssh_read_remote_file` | Read remote file |
| `ssh_status` | Connection status |
| `ssh_disconnect` | Disconnect |
| `ssh_reset_shell` | Reset shell state |

## Usage

### Connect

```javascript
// With private key
ssh_connect({
  host: "192.168.1.100",
  username: "user",
  privateKeyPath: "/path/to/private-key"
})

// With password
ssh_connect({
  host: "192.168.1.100",
  username: "user",
  password: "your-password"
})
```

### Quick Commands (ssh_exec)

Best for one-off commands that need exit code:

```javascript
ssh_exec({ command: "ls -la" })
// Returns: output + [exit code: 0]

ssh_exec({ command: "npm test" })
// Returns: output + [exit code: 0 or 1]
```

### Interactive Session (ssh_stream_*)

Best for stateful operations (cd, sudo, environment variables):

```javascript
// Start shell
ssh_stream_start({ stream_id: "main", command: "bash" })

// Run commands - output returned immediately!
ssh_stream_write({ data: "cd /var/www\n" })
ssh_stream_write({ data: "ls -la\n" })

// Sudo with password prompt
ssh_stream_write({ data: "sudo apt update\n" })
// Returns: "[sudo] password for user:" with [complete: true]
ssh_stream_write({ data: "your-password\n" })
// Returns: command output

// Cleanup when done
ssh_stream_stop({ stream_id: "main" })
```

### File Operations (SFTP)

```javascript
// Upload local file to remote
ssh_upload({ local_path: "./app.zip", remote_path: "/home/user/" })

// Download remote file to local
ssh_download({ remote_path: "/var/log/app.log", local_path: "./app.log" })

// Write content directly to remote file
ssh_write_remote_file({ remote_path: "/tmp/config.json", content: '{"key": "value"}' })

// Read remote file content
ssh_read_remote_file({ remote_path: "/etc/nginx/nginx.conf" })
```

## Auto-Read Feature

`ssh_stream_write` automatically polls for output (every 100ms) and returns when:
- Shell prompt detected (`$`, `#`, `>`)
- Password prompt detected (e.g., `[sudo] password for user:`)
- Timeout reached (default 5 seconds)

```javascript
// Auto-read enabled (default)
ssh_stream_write({ data: "ls -la\n" })
// → Returns output immediately with [complete: true]

// Disable auto-read for long-running commands
ssh_stream_write({ data: "tail -f /var/log/app.log\n", wait_ms: 0 })
// → Returns immediately, use ssh_stream_read to get output later
```

## When to Use Which?

| Scenario | Tool |
|----------|------|
| One-off commands | `ssh_exec` |
| Need exit code | `ssh_exec` |
| Sudo commands | `ssh_stream_*` |
| Change directory | `ssh_stream_*` |
| Set environment variables | `ssh_stream_*` |
| Long-running commands | `ssh_stream_*` |
| File transfer | `ssh_upload` / `ssh_download` |

## License

MIT
