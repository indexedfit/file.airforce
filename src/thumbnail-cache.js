// @ts-check
/**
 * Thumbnail generation and caching system
 *
 * Generates thumbnails from file content during bitswap fetch
 * Stores in IndexedDB for persistence across sessions
 * Keyed by CID for efficient lookup
 */

const DB_NAME = 'file-airforce-thumbnails'
const STORE_NAME = 'thumbnails'
const DB_VERSION = 1
const THUMB_SIZE = 300 // Square thumbnail size

/**
 * @typedef {Object} ThumbnailCache
 * @property {(cid: string) => Promise<string|null>} get - Get thumbnail data URL by CID
 * @property {(cid: string, dataUrl: string) => Promise<void>} set - Store thumbnail
 * @property {(blob: Blob, mimeType: string) => Promise<string|null>} generate - Generate thumbnail from blob
 */

/**
 * Open IndexedDB for thumbnail storage
 */
async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

/**
 * Generate thumbnail from image blob
 */
async function generateImageThumbnail(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        // Calculate dimensions maintaining aspect ratio
        let { width, height } = img
        if (width > height) {
          if (width > THUMB_SIZE) {
            height = (height * THUMB_SIZE) / width
            width = THUMB_SIZE
          }
        } else {
          if (height > THUMB_SIZE) {
            width = (width * THUMB_SIZE) / height
            height = THUMB_SIZE
          }
        }

        canvas.width = width
        canvas.height = height
        ctx.drawImage(img, 0, 0, width, height)

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        URL.revokeObjectURL(url)
        resolve(dataUrl)
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }

    img.src = url
  })
}

/**
 * Generate thumbnail from video blob (first frame)
 */
async function generateVideoThumbnail(blob) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(blob)
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true

    video.onloadedmetadata = () => {
      // Seek to 1 second or 10% through video
      video.currentTime = Math.min(1, video.duration * 0.1)
    }

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')

        let { videoWidth: width, videoHeight: height } = video
        if (width > height) {
          if (width > THUMB_SIZE) {
            height = (height * THUMB_SIZE) / width
            width = THUMB_SIZE
          }
        } else {
          if (height > THUMB_SIZE) {
            width = (width * THUMB_SIZE) / height
            height = THUMB_SIZE
          }
        }

        canvas.width = width
        canvas.height = height
        ctx.drawImage(video, 0, 0, width, height)

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        URL.revokeObjectURL(url)
        resolve(dataUrl)
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }

    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load video'))
    }

    video.src = url
  })
}

/**
 * Generate thumbnail from PDF (first page)
 * Returns null for now - requires pdf.js integration
 */
async function generatePDFThumbnail(blob) {
  // TODO: Integrate pdf.js for PDF thumbnails
  // For now, return null (will show file icon)
  return null
}

/**
 * Create thumbnail cache instance
 * @returns {Promise<ThumbnailCache>}
 */
export async function createThumbnailCache() {
  const db = await openDB()

  return {
    /**
     * Get cached thumbnail by CID
     */
    async get(cid) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const request = store.get(cid)

        request.onsuccess = () => resolve(request.result || null)
        request.onerror = () => reject(request.error)
      })
    },

    /**
     * Store thumbnail by CID
     */
    async set(cid, dataUrl) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        const request = store.put(dataUrl, cid)

        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    },

    /**
     * Generate thumbnail from blob based on MIME type
     */
    async generate(blob, mimeType) {
      try {
        if (mimeType.startsWith('image/')) {
          return await generateImageThumbnail(blob)
        } else if (mimeType.startsWith('video/')) {
          return await generateVideoThumbnail(blob)
        } else if (mimeType === 'application/pdf') {
          return await generatePDFThumbnail(blob)
        }
        return null // Unsupported type
      } catch (err) {
        console.warn('Thumbnail generation failed:', err)
        return null
      }
    }
  }
}

/**
 * Guess MIME type from filename
 */
export function guessMimeType(name = '') {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const map = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    // Video
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    // Documents
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
  }
  return map[ext] || 'application/octet-stream'
}
