// @ts-check
/**
 * Reactive thumbnail generation system
 *
 * Watches for new CIDs in room manifests, polls for block availability,
 * and generates thumbnails when blocks arrive (from bitswap or local upload).
 * Works for both host uploads and joiner downloads.
 */

import { createThumbnailCache, guessMimeType } from './thumbnail-cache.js'
import { emitThumbnailReady } from './thumbnail-events.js'

const POLL_INTERVAL = 500 // ms
const MAX_RETRIES = 60 // 30 seconds max wait

/**
 * @typedef {Object} PendingThumbnail
 * @property {string} cid
 * @property {string} name
 * @property {string} roomId
 * @property {number} retries
 */

export async function createThumbnailManager(fs) {
  const cache = await createThumbnailCache()

  /** @type {Map<string, PendingThumbnail>} */
  const pending = new Map() // cid -> pending info

  let pollTimer = null

  /**
   * Generate thumbnail for a CID (triggers bitswap fetch)
   */
  async function generateThumbnail(cid, name, roomId) {
    try {
      // Check cache first
      const existing = await cache.get(cid)
      if (existing) {
        emitThumbnailReady(roomId, cid, existing)
        return true
      }

      console.log(`[Thumbnail] Fetching blocks for ${name} via bitswap...`)
      // Fetch blocks and generate (this triggers bitswap if not local)
      const chunks = []
      for await (const chunk of fs.cat(cid)) {
        chunks.push(chunk)
      }
      console.log(`[Thumbnail] ✓ Got ${chunks.length} chunks for ${name}`)
      const blob = new Blob(chunks, { type: guessMimeType(name) })

      const thumbUrl = await cache.generate(blob, guessMimeType(name))
      if (thumbUrl) {
        await cache.set(cid, thumbUrl)
        emitThumbnailReady(roomId, cid, thumbUrl)
        console.log(`✓ Generated thumbnail for ${name}`)
        return true
      }
    } catch (err) {
      console.warn(`Thumbnail generation failed for ${name}:`, err.message)
    }
    return false
  }

  /**
   * Process pending thumbnails (attempts generation which triggers bitswap)
   */
  async function poll() {
    const toRemove = []

    for (const [cid, info] of pending.entries()) {
      // Attempt to generate (this will trigger bitswap fetch)
      const success = await generateThumbnail(cid, info.name, info.roomId)
      if (success) {
        toRemove.push(cid)
      } else {
        // Failed to generate, retry
        info.retries++
        if (info.retries >= MAX_RETRIES) {
          console.warn(`Giving up on thumbnail for ${info.name} after ${MAX_RETRIES} retries`)
          toRemove.push(cid)
        }
      }
    }

    // Clean up
    for (const cid of toRemove) {
      pending.delete(cid)
    }

    // Stop polling if nothing pending
    if (pending.size === 0 && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /**
   * Check if file type supports thumbnails
   */
  function supportsThumb(name) {
    const mime = guessMimeType(name)
    return mime.startsWith('image/') || mime.startsWith('video/') || mime === 'application/pdf'
  }

  /**
   * Queue files for thumbnail generation
   */
  function queueFiles(roomId, files) {
    // Only queue files that support thumbnails
    const newPending = files.filter(f =>
      !pending.has(f.cid) && supportsThumb(f.name)
    )

    for (const file of newPending) {
      pending.set(file.cid, {
        cid: file.cid,
        name: file.name,
        roomId,
        retries: 0
      })
    }

    // Start polling if we have pending items
    if (pending.size > 0 && !pollTimer) {
      pollTimer = setInterval(poll, POLL_INTERVAL)
    }
  }

  /**
   * Watch a room's manifest for new files
   */
  function watchRoom(roomId, getManifest) {
    let prevCids = new Set()

    return () => {
      const manifest = getManifest()
      const files = manifest?.files || []
      const currentCids = new Set(files.map(f => f.cid))

      // Find new CIDs
      const newFiles = files.filter(f => !prevCids.has(f.cid))
      if (newFiles.length > 0) {
        console.log(`[ThumbnailManager] Queueing ${newFiles.length} files for room ${roomId.slice(0, 6)}`)
        queueFiles(roomId, newFiles)
      }

      prevCids = currentCids
    }
  }

  return {
    watchRoom,
    queueFiles,
  }
}
