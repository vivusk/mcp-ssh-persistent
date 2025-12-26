/**
 * MCP response formatting utilities
 * Standardizes response structure for tool handlers
 */

/**
 * Create success response with JSON content
 * @param {object} data - Data to serialize
 * @returns {object} MCP response object
 */
export function jsonResponse(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Create success response with plain text
 * @param {string} text - Text content
 * @returns {object} MCP response object
 */
export function textResponse(text) {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Create error response
 * @param {string} message - Error message
 * @returns {object} MCP response object with isError flag
 */
export function errorResponse(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Create exec result response with exit code info
 * @param {object} result - Exec result { output, exitCode, timedOut }
 * @param {number} timeout - Timeout value used
 * @returns {object} MCP response object
 */
export function execResponse(result, timeout) {
  let text = result.output;
  if (result.timedOut) {
    text += `\n[timed out after ${timeout}ms]`;
  }
  text += `\n[exit code: ${result.exitCode}]`;
  return {
    content: [{ type: 'text', text }],
    isError: result.exitCode !== 0,
  };
}
