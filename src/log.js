/**
 * Timestamped console events (ISO-8601). Easy to swap for a file/structured sink later.
 * @param {string} message
 */
export function logEvent(message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
}
