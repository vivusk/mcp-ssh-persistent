/**
 * Stream registry for the session pool (D12).
 * Global index stream_id -> alias (ids are unique across aliases), plus
 * open / lookup / close of ShellStreams held in each session's `streams` map,
 * capped at limits.maxStreams per session.
 */

/**
 * @param {object} deps
 * @param {Function} deps.lookupSession - alias -> live Session or undefined
 * @param {Function} deps.withSession - (alias, fn) -> fn(session) with channel-open error mapping
 * @param {Function} deps.getLimits - () -> limits
 * @param {Function} deps.openShell - (client, opts) -> Promise<ShellStream>
 */
export function createStreamRegistry({ lookupSession, withSession, getLimits, openShell }) {
  const index = new Map(); // stream_id -> canonical alias

  /** Bind / unbind a stream_id to a session alias. */
  const registerStream = (streamId, alias) => { index.set(streamId, alias); };
  const unregisterStream = (streamId) => { index.delete(streamId); };

  /** Drop index entries owned by an alias. */
  function forgetAlias(alias) {
    for (const [id, owner] of index) if (owner === alias) index.delete(id);
  }

  /** @returns {string[]} stream ids bound to an alias */
  const idsFor = (alias) => [...index].filter(([, a]) => a === alias).map(([id]) => id);

  /**
   * Session owning a stream_id.
   * @param {string} streamId
   * @returns {Promise<object>} Session
   */
  async function getStreamSession(streamId) {
    const alias = index.get(streamId);
    if (!alias) throw new Error(`unknown stream_id "${streamId}"; start it with ssh_stream_start`);
    const session = lookupSession(alias);
    if (!session || !session.connection.isConnected()) {
      index.delete(streamId);
      throw new Error(`stream_id "${streamId}" lost: connection to ${alias} closed`);
    }
    return session;
  }

  /**
   * Open a new shell stream on an alias. Duplicate ids (any alias) and streams
   * beyond limits.maxStreams per session are refused; existing streams untouched.
   * @returns {Promise<{session:object, stream:object}>}
   */
  function openStream(alias, streamId) {
    return withSession(alias, async (session) => {
      const owner = index.get(streamId);
      if (owner) throw new Error(`stream_id ${streamId} already open on ${owner}; stop it or pick another id`);
      const { maxStreams, streamBufferBytes } = getLimits();
      if (session.streams.size >= maxStreams) throw new Error(`max ${maxStreams} streams for ${session.alias}; stop one first`);
      session.streams.set(streamId, null); // reserve slot + id before the async open
      index.set(streamId, session.alias);
      const release = () => {
        if (index.get(streamId) === session.alias) index.delete(streamId);
        session.streams.delete(streamId);
      };
      try {
        const stream = await openShell(session.connection.getClient(), {
          streamId, alias: session.alias, username: session.server.username, bufferBytes: streamBufferBytes,
        });
        if (lookupSession(session.alias) !== session) {
          stream.close();
          throw new Error(`connection to ${session.alias} closed`);
        }
        session.streams.set(streamId, stream);
        stream.onClose(() => { if (session.streams.get(streamId) === stream) release(); });
        return { session, stream };
      } catch (err) {
        release();
        throw err;
      }
    });
  }

  /** @returns {Promise<{session:object, stream:object}>} an open stream by id */
  async function getStream(streamId) {
    const session = await getStreamSession(streamId);
    const stream = session.streams.get(streamId);
    if (!stream || !stream.active) throw new Error(`stream_id "${streamId}" is not open`);
    return { session, stream };
  }

  /** Ctrl+C then close one stream (other streams of the session are untouched). */
  async function closeStream(streamId) {
    const { session, stream } = await getStream(streamId);
    stream.interrupt();
    stream.close();
    session.streams.delete(streamId);
    index.delete(streamId);
    return session.alias;
  }

  return { registerStream, unregisterStream, forgetAlias, idsFor, getStreamSession, openStream, getStream, closeStream };
}
