# mcp-ssh-persistent

MCP server for Claude Code that keeps SSH connections open to named servers and supports streaming shells.

## Features

- **Server aliases.** Every tool takes `server: "<alias>"`. Host, user and key live in a local `config.json`, so they never appear in prompts. The first call to an alias connects lazily. A dropped connection reconnects once on the next call. Keepalive is 15 s × 3.
- **Host-key pinning (TOFU).** The first connect pins the server's `SHA256:` fingerprint in `known-hosts.json`. On a mismatch the server refuses to connect. You can also pre-set `fingerprint` per server in config.
- **No secrets in the LLM context.**
  - Config rejects any `password` key.
  - Sudo uses a password stored in the OS credential store (Windows Credential Manager, macOS Keychain or Linux Secret Service). The model never sees or types it.
  - Logs and responses go through secret redaction.
- **Exact command completion.** Stream shells use a unique prompt marker, so a write returns as soon as the command finishes. The server also detects input prompts.
- **Local path policy.** Uploads and downloads only touch allowed directories. Key dirs and agent config are always denied.
- **Atomic remote writes.** The server writes a temp file, keeps the mode and owner, then renames it over the target. Remote symlinks are followed.
- **Fast SFTP.** Transfers use parallel `fastPut`/`fastGet` over one cached SFTP channel per server.
- **Bounded output.** Exec output is capped: the first 20% and last 80% are kept, with a `[truncated N bytes]` marker. Stream buffers are capped, and multi-byte UTF-8 characters are never split.
- **Channel budget.** Per-server limits stay below the default OpenSSH `MaxSessions 10`. Extra exec calls wait in a queue instead of failing.

## Requirements

- Node.js >= 18 (tested on 22 and 24; `npm test` needs >= 21).
- Windows, macOS or Linux. `sudo` support uses the OS credential store; on Linux it needs a running Secret Service daemon (e.g. gnome-keyring or KeePassXC), so headless servers usually lack it. Other tools work on any OS.
- `bash` on each remote server: `ssh_exec sudo:true` runs `bash -c`, and stream shells assume a bash login shell.

## Setup

### Option A: npm (recommended)

1. Create `~/.mcp-ssh-persistent/config.json` from [config.example.json](config.example.json):
   - add your aliases;
   - set `localPathRoots` to your workspace dir(s). **If you skip this, uploads and downloads outside the OS temp dir are rejected.**

   `known-hosts.json` and `logs/` are created next to the config file. Set the env var `MCP_SSH_CONFIG` to use a config file somewhere else (a leading `~/` is expanded).
2. Optional, for sudo: store the sudo password of a remote user in the OS credential store. A hidden prompt asks for the password:
   ```bash
   npx -p mcp-ssh-persistent mcp-ssh-persistent-set-sudo-password <remote-username>
   ```
   `<remote-username>` is the `username` of the alias. Add `--delete` to remove it. Where it is stored:
   - Windows: Credential Manager entry `mcp-ssh-persistent:sudo:<remote-username>`.
   - macOS: generic password in the login keychain, service `mcp-ssh-persistent`, account `sudo:<remote-username>`. Inspect it with `security find-generic-password -s mcp-ssh-persistent -a sudo:<remote-username>`. Passwords with line breaks are rejected.
   - Linux: Secret Service item, service `mcp-ssh-persistent`, account `sudo:<remote-username>`.
3. Register the server with Claude Code, e.g. in a project `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "ssh": { "command": "npx", "args": ["-y", "mcp-ssh-persistent"] }
     }
   }
   ```
   Restart Claude Code. Connect to each alias for the first time from a trusted network, because that first connect pins the host key.

### Option B: git clone

1. Clone and install:
   ```bash
   git clone https://github.com/vivusk/mcp-ssh-persistent.git
   cd mcp-ssh-persistent && npm install
   cp config.example.json config.json
   ```
   Edit `config.json` (gitignored) as in option A. A `config.json` inside the package dir takes precedence over `~/.mcp-ssh-persistent/config.json`.
2. Optional, for sudo: `npm run set-sudo-password -- <remote-username>`.
3. Register with `"command": "node", "args": ["<path-to>/mcp-ssh-persistent/src/index.js"]` and restart Claude Code.

### macOS notes

- To use a passphrase-protected key without prompts, set `useAgent: true` and run `ssh-add --apple-use-keychain ~/.ssh/<key>` once to store the passphrase in the Keychain. The agent starts empty after each login, so load the key again with `ssh-add --apple-load-keychain` (or let `ssh` do it via `AddKeysToAgent yes` + `UseKeychain yes` in `~/.ssh/config`). launchd provides `SSH_AUTH_SOCK` to apps started from the GUI.
- Local path matching is case-insensitive, like the default APFS volume.

### Upgrading from 1.x

2.0 is a breaking release: `ssh_connect` and `ssh_reset_shell` are gone, every tool takes `server: "<alias>"` from the config file, and passwords are no longer accepted in config.

### config.json

```json
{
  "defaults": { "privateKeyPath": "<path-to-private-key>", "port": 22 },
  "servers": {
    "web": { "host": "203.0.113.10", "username": "deploy" },
    "db":  { "host": "203.0.113.20", "username": "root", "port": 2222, "fingerprint": "SHA256:<base64>" },
    "lab": { "host": "203.0.113.30", "username": "ops", "useAgent": true }
  },
  "localPathRoots": ["<your-workspace-dir>"],
  "localPathDeny": [],
  "limits": { "maxOutputBytes": 102400, "maxReadFileBytes": 2097152, "streamBufferBytes": 524288, "maxStreams": 4, "maxConcurrentExec": 4 }
}
```

| Key | Meaning |
|-----|---------|
| `defaults` | Values merged into every server: `port` (22), `privateKeyPath`, `useAgent` (false), `keepaliveInterval` (15000), `keepaliveCountMax` (3), `readyTimeout` (10000) |
| `privateKeyPath` | Accepts `~/`. A relative path resolves against the config dir; an absolute path is used as is. |
| `servers.<alias>` | `host` and `username` are required. Any key from `defaults`, plus an optional `fingerprint`, which wins over `known-hosts.json`. Aliases are case-insensitive. |
| `useAgent` | Use ssh-agent. Reads `SSH_AUTH_SOCK`; on Windows the default is the OpenSSH agent pipe. |
| `localPathRoots` | Extra allowed local roots for upload/download. `os.tmpdir()` is always allowed. Accepts `~/`; relative paths resolve against the config dir. |
| `localPathDeny` | Extra denied local paths. A deny rule always wins over a root. Accepts `~/`; relative paths resolve against the config dir. |
| `limits` | Output caps and channel budget (see below) |

## Tools

All tools return plain text. **bold** marks required params.

| Tool | Params | Purpose |
|------|--------|---------|
| `ssh_exec` | **`server`**, **`command`**, `timeout` (ms, 30000), `pty` (false), `sudo` (false) | Stateless command on an exec channel. Returns stdout, a `--- stderr ---` section when stderr is non-empty, and `[exit: N]` |
| `ssh_stream_start` | **`server`**, **`stream_id`**, `command`, `wait_ms` (2000) | Opens a stateful shell (history disabled) bound to `stream_id`. `stream_id` must be unique across servers |
| `ssh_stream_write` | **`stream_id`**, **`data`**, `wait_ms` (5000; 0 = no wait) | Writes `data` verbatim (end it with a newline to press Enter), then waits for the prompt, an input prompt or the timeout |
| `ssh_stream_read` | **`stream_id`**, `clear` (true), `wait_ms` (0) | Reads buffered output since the last read or write |
| `ssh_sudo_auth` | **`stream_id`**, `wait_ms` (5000) | Answers a pending `[sudo] password for <user>:` (or sudo-rs `[sudo: authenticate] Password:`) prompt with the password from the OS credential store |
| `ssh_stream_stop` | **`stream_id`** | Sends Ctrl+C, then closes that stream's shell channel |
| `ssh_upload` | **`server`**, **`local_path`**, **`remote_path`** | SFTP upload. A `remote_path` ending in `/` is treated as a directory |
| `ssh_download` | **`server`**, **`remote_path`**, **`local_path`** | SFTP download to a `.part` file, then a rename (no half-written files) |
| `ssh_write_remote_file` | **`server`**, **`remote_path`**, **`content`**, `mode` (octal string, e.g. `"600"`) | Atomic write of text content without shell escaping |
| `ssh_read_remote_file` | **`server`**, **`remote_path`** | Reads a text file and returns `# <path> (<bytes> bytes)` followed by the content. Binary files and files over `maxReadFileBytes` are refused |
| `ssh_status` | none | Pooled sessions: alias, host, user, connected, fingerprint, streams |
| `ssh_disconnect` | `server` (omit to disconnect all) | Closes one session or all of them |

### Exec vs stream

| Scenario | Tool |
|----------|------|
| One-off command, need exit code | `ssh_exec` |
| One-off command as root (non-root user) | `ssh_exec` with `sudo: true` |
| `cd` / env vars / multi-step state | `ssh_stream_*` |
| `tail -f`, `pm2 logs`, interactive prompts | `ssh_stream_*` |
| File transfer / edit | `ssh_upload`, `ssh_download`, `ssh_write_remote_file`, `ssh_read_remote_file` |

### Stream states

Every stream result ends with a footer line:

| Footer | Meaning |
|--------|---------|
| `[state: prompt]` | Command finished, and the shell is back at its prompt |
| `[state: awaiting_input(sudo)]` | Exactly `[sudo] password for <alias user>:` or the sudo-rs prompt `[sudo: authenticate] Password:` (Ubuntu 25.10+ default) is showing. Call `ssh_sudo_auth` |
| `[state: awaiting_input(password)]` | Some other password prompt (`ssh`, `su`, `mysql -p`, `Password:`). `ssh_sudo_auth` refuses these |
| `[state: awaiting_input(confirm)]` | A `(yes/no)`-style prompt. Answer it with `ssh_stream_write` |
| `[state: timeout]` | `wait_ms` elapsed and the command may still be running. Use `ssh_stream_read` |
| `[state: running]` | Read only: no prompt yet |
| `[state: closed]` | The stream channel closed |

If the stream buffer cap dropped bytes, the result also shows `[truncated N bytes]`. If a write found output nobody had read, it reports that output instead of discarding it.

**`sudo -s` / other shells:** a root shell started with `sudo -s` or `su` does not use the marker prompt. The server then falls back to a generic `$`/`#` prompt match after 300 ms of quiet. That works but is slower and less exact. Use `sudo:true` on `ssh_exec` when you can.

## Sudo

Never put a password in any tool argument or command line. There are two supported paths:

1. **`ssh_exec` with `sudo: true`.** The server runs `sudo -S -k -p '<per-call random marker>' -- bash -c '<command>'`. It writes the password only after sudo's own prompt appears. If the host needs no password (NOPASSWD), it writes nothing. Limits:
   - the command's stdin is EOF, so interactive commands do not work;
   - refused when the alias user is `root`, and refused together with `pty: true`;
   - hosts with `Defaults requiretty` reject it; use a stream instead;
   - `bash` is required on the remote.
2. **Stream + `ssh_sudo_auth`.** Type the command (`sudo apt update\n`) with `ssh_stream_write`. If the footer shows `awaiting_input(sudo)`, call `ssh_sudo_auth`. sudo caches credentials, so read the footer first: when no prompt appeared, there is nothing to answer.

**Residual risk:** a program running in the stream as the session user can print an exact fake `[sudo] password for <user>:` or `[sudo: authenticate] Password:` line. The sudo-rs prompt names no user, so `ssh_sudo_auth` cannot tell whose password it asks for. After `su <other-user>` or `ssh <other-host>` inside the stream, a sudo-rs prompt there would still receive the alias user's password; do not call `ssh_sudo_auth` in such nested shells. Only call `ssh_sudo_auth` right after a command you typed yourself that starts with `sudo`.

Stream shells start with history disabled, so commands typed through the MCP server are not saved to `~/.bash_history`.

## Local path policy

`local_path` of `ssh_upload` and `ssh_download` is resolved with realpath. Path comparison is case-insensitive on macOS and Windows (case-sensitive on Linux); the deny names below (`.claude`, `.git`, `.mcp.json`, `CLAUDE.md`) match in any case on every OS. The path must lie under `os.tmpdir()` or a `localPathRoots` entry. The working directory is **not** a default root.

These paths are always denied, even inside a root:
- the directory of every configured `privateKeyPath`;
- `~/.ssh` and `~/.claude`;
- this repo directory;
- the config file and its `known-hosts.json`;
- any path with a `.claude` or `.git` segment;
- any file named `.mcp.json` or `CLAUDE.md`;
- every `localPathDeny` entry.

Windows alternate data streams (`file:stream`) are rejected.

## Channel budget

By default OpenSSH allows `MaxSessions 10` channels per connection. Per server this tool uses:
- up to `maxStreams` (4) shell channels;
- 1 cached SFTP channel;
- up to `maxConcurrentExec` (4) exec channels. More exec calls wait in a FIFO queue.

That makes 9 ≤ 10. If you raise the limits, raise `MaxSessions` in the server's `sshd_config` as well. The server logs a warning when the configured budget is above 10.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `HOST KEY MISMATCH for <alias> ...` | The server key changed. Verify it out of band. If the change is legitimate, delete the entry named in the error (in `known-hosts.json`, or `fingerprint` in config) and reconnect |
| `ssh-agent not available ...` | Windows: start the OpenSSH agent service and run `ssh-add`. macOS: run `ssh-add --apple-load-keychain` after each login, or `ssh-add --apple-use-keychain <key>` the first time (launchd sets `SSH_AUTH_SOCK`). Linux: start `ssh-agent` in the session that launches Claude Code and run `ssh-add`. Or set `privateKeyPath` and `useAgent: false` |
| `local path "..." is outside the ...` / `... is denied (<rule>)` | Add the dir to `localPathRoots` in `config.json`, or use a temp dir. Denied paths (key dirs, `.claude`, `.git`, `CLAUDE.md`, ...) cannot be allowed. If a `privateKeyPath` sits directly in your home dir, the whole home dir (incl. the Windows temp dir) is denied, so move keys into their own dir |
| `[truncated N bytes]` | The output cap was hit. Narrow the command (`head`, `tail`, `grep`, `sed -n`), raise `limits.maxOutputBytes`, or use `ssh_download` |
| `server MaxSessions reached for <alias>` | Stop an unused stream (`ssh_stream_stop`) or retry. Check `MaxSessions` in the server's `sshd_config` |
| `max 4 streams for <alias>` | Stop a stream first, or raise `limits.maxStreams` (stay within the channel budget) |
| `No sudo password in the OS credential store (...) ...` | Run `npm run set-sudo-password -- <remote-username>` (or the `npx` command from Setup) |
| `macOS Keychain ... (unlock the login keychain)` | Unlock it (`security unlock-keychain`) or log in to the Mac's GUI session, then retry |
| `Secret Service ... failed ...` | Linux: install and unlock a Secret Service keyring (gnome-keyring or KeePassXC). If the message says `@napi-rs/keyring failed to load`, reinstall dependencies (`npm ci`) on a supported architecture |

The server writes its log to `logs/mcp-ssh.log` (beside the config file), rotated at 1 MB and redacted.

## Development

```bash
npm test                     # unit tests (node --test)
npm run smoke -- <alias>     # live read-only smoke (writes only under /tmp/mcp-ssh-smoke-*)
npm run smoke:mcp -- <alias> # spawns the MCP server and drives it over stdio
```

Environment variables:

| Variable | Meaning |
|----------|---------|
| `MCP_SSH_CONFIG` | Path of the config file (leading `~/` expanded) |
| `MCP_SSH_CRED_BACKEND` | Windows only: `powershell` forces the PowerShell Credential Manager backend instead of `@napi-rs/keyring`. The old name `MCP_SSH_WCM_BACKEND` is still accepted; the new name wins if both are set |
| `MCP_SSH_TEST_KEYCHAIN` | Tests only: `1` enables round-trip tests that write a throwaway `__mcp_test__` item to the real macOS login keychain / Linux Secret Service. Off by default |

CI (`.github/workflows/test.yml`) runs `npm test` on Ubuntu, macOS and Windows with Node 22 and 24; the macOS job sets `MCP_SSH_TEST_KEYCHAIN=1`.

## License

MIT
