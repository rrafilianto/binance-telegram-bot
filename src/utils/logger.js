/**
 * Standardized logger utility with timestamps and contextual tags
 */

function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

export const logger = {
  info(tag, ...args) {
    console.log(`[${getTimestamp()}] [INFO] [${tag}]`, ...args);
  },
  warn(tag, ...args) {
    console.warn(`[${getTimestamp()}] [WARN] [${tag}]`, ...args);
  },
  error(tag, ...args) {
    console.error(`[${getTimestamp()}] [ERROR] [${tag}]`, ...args);
  },
  debug(tag, ...args) {
    console.log(`[${getTimestamp()}] [DEBUG] [${tag}]`, ...args);
  },
};
