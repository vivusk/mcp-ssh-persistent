/**
 * Token-lean text for ShellStream write/read results.
 * Output, then a footer `[state: ...]` (+ hint for input prompts) and
 * `[truncated N bytes]` when the stream buffer cap dropped bytes.
 */
import { textResponse } from '../utils/response.js';

const HINTS = {
  sudo: 'sudo password prompt for this session user; call ssh_sudo_auth',
  password: 'not a sudo prompt for this user; ssh_sudo_auth will refuse',
  confirm: 'confirmation prompt; answer with ssh_stream_write',
};
const STATE_HINTS = {
  timeout: 'command may still be running; use ssh_stream_read',
  closed: 'stream closed',
};

/**
 * @param {object} result - { output, state, kind?, droppedBytes? }
 * @param {string} [header] - Optional first line(s), e.g. init warning
 * @returns {object} MCP response
 */
export function formatStreamResult(result, header = '') {
  const parts = [];
  if (header) parts.push(header);
  const output = String(result.output ?? '').replace(/\s+$/, '');
  if (output) parts.push(output);
  const state = result.state === 'awaiting_input' ? `awaiting_input(${result.kind})` : result.state;
  const hint = result.state === 'awaiting_input' ? HINTS[result.kind] : STATE_HINTS[result.state];
  parts.push(`[state: ${state}]${hint ? ` ${hint}` : ''}`);
  if (result.droppedBytes > 0) parts.push(`[truncated ${result.droppedBytes} bytes]`);
  return textResponse(parts.join('\n'));
}
