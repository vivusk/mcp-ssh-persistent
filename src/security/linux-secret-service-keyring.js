/**
 * Linux Secret Service backend for the sudo password store (D-M2).
 * Uses @napi-rs/keyring `new Entry(service, account)`; the napi module is
 * passed in so unit tests can inject a fake `{ Entry }`.
 * Missing item: `getPassword()` → null OR a NoEntry-style error (D-M7).
 */

const NO_ENTRY_RE = /no ?entry|not found/i;
const HINT = 'install/unlock a Secret Service keyring (gnome-keyring/KeePassXC)';

/** True when a napi error means "no such item". */
const isNoEntry = (err) => NO_ENTRY_RE.test(String(err?.message ?? '')) || NO_ENTRY_RE.test(String(err?.code ?? ''));

/** Wrap a napi error with the Secret Service hint. */
function wrap(op, err) {
  return new Error(`Secret Service ${op} failed: ${err?.message ?? err} (${HINT})`, { cause: err });
}

/**
 * @param {{Entry: Function}} napi
 * @returns {string|null} secret, or null when missing
 */
export function linuxReadPassword(napi, service, account) {
  try {
    const pw = new napi.Entry(service, account).getPassword();
    return pw ?? null;
  } catch (err) {
    if (isNoEntry(err)) return null;
    throw wrap('read', err);
  }
}

/** Store (overwrite) a secret, then verify by reading it back. */
export function linuxWritePassword(napi, service, account, secret) {
  try {
    new napi.Entry(service, account).setPassword(secret);
  } catch (err) {
    throw wrap('write', err);
  }
  if (linuxReadPassword(napi, service, account) !== secret) {
    throw new Error(`Secret Service write failed (read-back mismatch; ${HINT})`);
  }
}

/** @returns {boolean} true when deleted; false when missing (false/null result or NoEntry error) */
export function linuxDeletePassword(napi, service, account) {
  try {
    return Boolean(new napi.Entry(service, account).deletePassword());
  } catch (err) {
    if (isNoEntry(err)) return false;
    throw wrap('delete', err);
  }
}
