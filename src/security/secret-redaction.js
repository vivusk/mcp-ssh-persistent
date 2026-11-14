/**
 * Secret redaction
 * Keeps an in-memory registry of secrets (sudo passwords, per-call markers, ...)
 * and scrubs them from any text before it reaches logs or tool responses.
 */

// Registered secrets; never persisted anywhere.
const secrets = new Set();

// PEM private key blocks (RSA/EC/OPENSSH/ENCRYPTED ...) are always redacted.
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const MASK = '***';

/**
 * Register a secret so that redact() masks it from now on.
 * Very short strings (< 4 chars) are ignored to avoid masking common text.
 * @param {string} str - Secret value
 */
export function registerSecret(str) {
  if (typeof str !== 'string' || str.length < 4) return;
  secrets.add(str);
}

/**
 * Replace every registered secret and any PEM private key block with `***`.
 * @param {*} text - Text to scrub (non-strings are stringified)
 * @returns {string} Redacted text
 */
export function redact(text) {
  if (text === undefined || text === null) return '';
  let out = typeof text === 'string' ? text : String(text);
  out = out.replace(PRIVATE_KEY_RE, MASK);
  if (secrets.size === 0) return out;
  // Longest first so a secret containing another secret is fully masked.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  return out;
}
