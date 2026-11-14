/**
 * Where config, known-hosts and logs live (dependency-free, so logger and config can share it).
 * Order: env MCP_SSH_CONFIG -> `<package dir>/config.json` if present (git clone)
 * -> `~/.mcp-ssh-persistent/config.json` (npm/npx install, survives package updates).
 * known-hosts.json and logs/ always sit beside the config file.
 */
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @returns {string} absolute path of the config file in use */
export function getConfigPath() {
  if (process.env.MCP_SSH_CONFIG) return resolve(process.env.MCP_SSH_CONFIG);
  const packaged = join(PACKAGE_DIR, 'config.json');
  if (existsSync(packaged)) return packaged;
  return join(homedir(), '.mcp-ssh-persistent', 'config.json');
}

/** @returns {string} directory holding logs (beside the config file) */
export function getLogDir() {
  return join(dirname(getConfigPath()), 'logs');
}
