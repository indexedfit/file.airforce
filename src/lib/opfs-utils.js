// @ts-check
/**
 * Shared OPFS detection utility
 * Safari has getDirectory but not createWritable, so we check for full support
 */

export function supportsOPFS() {
  try {
    // Check if FileSystem Access API exists
    if (!navigator?.storage?.getDirectory) return false;

    // Safari has getDirectory but not createWritable - check for that
    if (typeof FileSystemFileHandle !== 'undefined' &&
        typeof FileSystemFileHandle.prototype.createWritable === 'undefined') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
