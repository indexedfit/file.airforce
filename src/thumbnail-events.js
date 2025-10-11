// @ts-check
/**
 * Event system for thumbnail generation updates
 * Allows UI to reactively update as thumbnails become available
 */

const listeners = new Map() // roomId -> Set<callback>

/**
 * Subscribe to thumbnail updates for a room
 * @param {string} roomId
 * @param {(cid: string, dataUrl: string) => void} callback
 * @returns {() => void} Unsubscribe function
 */
export function onThumbnailReady(roomId, callback) {
  if (!listeners.has(roomId)) {
    listeners.set(roomId, new Set())
  }
  listeners.get(roomId).add(callback)

  return () => {
    const set = listeners.get(roomId)
    if (set) {
      set.delete(callback)
      if (set.size === 0) listeners.delete(roomId)
    }
  }
}

/**
 * Emit thumbnail ready event
 * @param {string} roomId
 * @param {string} cid
 * @param {string} dataUrl
 */
export function emitThumbnailReady(roomId, cid, dataUrl) {
  const set = listeners.get(roomId)
  if (set) {
    for (const callback of set) {
      try {
        callback(cid, dataUrl)
      } catch (err) {
        console.warn('Thumbnail callback error:', err)
      }
    }
  }
}
