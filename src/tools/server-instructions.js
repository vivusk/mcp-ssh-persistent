/**
 * MCP server `instructions`: usage + security rules the client injects into every
 * session that loads this server, so they apply without a project CLAUDE.md.
 * Alias roles (root / non-root) are derived from config.json (no hosts or users leaked).
 */
import { listServerAliases, resolveServer } from '../config/load-config-and-server-aliases.js';

/** "D (root), RR (non-root)" — a broken config or alias yields what can be resolved. */
function aliasSummary() {
  let aliases;
  try {
    aliases = listServerAliases();
  } catch {
    return '(config unreadable)';
  }
  if (!aliases.length) return '(none configured)';
  return aliases
    .map((alias) => {
      try {
        return `${alias} (${resolveServer(alias).username === 'root' ? 'root' : 'non-root'})`;
      } catch {
        return `${alias} (invalid)`;
      }
    })
    .join(', ');
}

/** @returns {string} instructions text for the MCP initialize response */
export function buildServerInstructions() {
  return `Persistent SSH to servers by alias. "ssh <ALIAS>" / "on <ALIAS>" means use these tools with server: "<ALIAS>".
Aliases: ${aliasSummary()}.

Tools: ssh_exec for one-off commands (stdout, "--- stderr ---", [exit: N]). ssh_stream_start/write/read/stop for stateful or interactive shells (footer [state: prompt | awaiting_input(sudo|password|confirm) | timeout | running | closed]); stop streams when done. ssh_read_remote_file / ssh_write_remote_file for files (no shell escaping), ssh_upload / ssh_download for SFTP (local paths limited to tmp + localPathRoots).

SECURITY (mandatory):
- NEVER put a password in any tool argument or command (no "echo pass | sudo -S", no password in ssh_stream_write).
- Sudo on non-root aliases: one-off -> ssh_exec { sudo: true } (password from OS credential store). Interactive -> stream; call ssh_sudo_auth only when the footer shows awaiting_input(sudo) right after a command you typed starting with sudo. Root aliases: run commands directly, no sudo flag.
- If the sudo password is missing, ask the user to run it themselves: "npx -p mcp-ssh-persistent mcp-ssh-persistent-set-sudo-password <username>" (or "npm run set-sudo-password -- <username>" in a repo checkout).
- "HOST KEY MISMATCH": stop and tell the user; only after they verify the new key, delete the entry named in the error from known-hosts.json.
- Confirm with the user before destructive or service-affecting commands (restarts, rm, DB writes, firewall changes) unless explicitly told to proceed.`;
}
