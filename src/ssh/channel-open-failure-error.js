/**
 * Channel-open failure mapping (D12)
 * OpenSSH limits channels per connection (MaxSessions, default 10). ssh2 reports
 * a refused exec/shell/sftp channel as "(SSH) Channel open failure: ...".
 */

/** @returns {boolean} true when err is an ssh2 channel-open refusal */
export function isChannelOpenFailure(err) {
  return /Channel open failure/i.test(err?.message || '');
}

/**
 * Convert a channel-open refusal into an actionable error; other errors pass through.
 * @param {Error} err
 * @param {string} alias - Server alias
 * @returns {Error}
 */
export function mapChannelOpenError(err, alias) {
  if (!isChannelOpenFailure(err)) return err;
  return new Error(`server MaxSessions reached for ${alias}; stop a stream (ssh_stream_stop) or retry`);
}
