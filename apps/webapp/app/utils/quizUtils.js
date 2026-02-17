// Import the shared quiz helpers from @classmoji/utils
export {
  checkForCompletion,
  getQuestionProgressFromMessage,
  parseQuestionComplete,
} from '@classmoji/utils';

/**
 * Format a duration in milliseconds to a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @param {object} options - Formatting options
 * @param {boolean} options.compact - Use compact format (e.g., "5m 30s" vs "5 min 30 sec")
 * @returns {string} Formatted duration string
 */
export const formatDuration = (ms, { compact = false } = {}) => {
  if (!ms || ms < 0) return compact ? '0s' : '0 seconds';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (compact) {
    // Compact format: "1h 5m 30s" or "5m 30s" or "30s"
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  // Verbose format: "1 hr 5 min 30 sec"
  const parts = [];
  if (hours > 0) parts.push(`${hours} hr`);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} sec`);
  return parts.join(' ');
};
