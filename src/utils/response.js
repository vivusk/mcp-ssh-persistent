/**
 * MCP response formatting utilities
 * Standardizes response structure for tool handlers.
 * Every text leaving the server passes through secret redaction.
 */
import { redact } from '../security/secret-redaction.js';

/**
 * Plain-text tool response (preferred: no JSON escaping, token-lean).
 * @param {string} text - Text content
 * @param {boolean} [isError=false] - Mark as tool error
 * @returns {object} MCP response object
 */
export function toolText(text, isError = false) {
  const response = { content: [{ type: 'text', text: redact(text) }] };
  if (isError) response.isError = true;
  return response;
}

/**
 * Compact JSON response for small status objects (no pretty-print).
 * String leaves are redacted BEFORE serialization: JSON escaping (`"` -> `\"`)
 * would otherwise stop secrets containing quotes/backslashes from matching.
 * @param {object} data - Data to serialize
 * @returns {object} MCP response object
 */
export function jsonResponse(data) {
  return toolText(JSON.stringify(data, (_k, v) => (typeof v === 'string' ? redact(v) : v)));
}

/**
 * Create success response with plain text
 * @param {string} text - Text content
 * @returns {object} MCP response object
 */
export function textResponse(text) {
  return toolText(text);
}

/**
 * Create error response
 * @param {string} message - Error message
 * @returns {object} MCP response object with isError flag
 */
export function errorResponse(message) {
  return toolText(`Error: ${message}`, true);
}
