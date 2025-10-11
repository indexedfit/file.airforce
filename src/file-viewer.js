// @ts-check
/**
 * In-app file viewer modal
 * Handles images, video, audio, text with native HTML5 elements
 * Safari iOS compatible (uses data URLs instead of blob URLs)
 */

import { guessMime } from './file-manager.js'

let modal = null

/**
 * Detect Safari/iOS for blob URL workarounds
 */
function isSafariOrIOS() {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || /^((?!chrome|android).)*safari/i.test(ua)
}

/**
 * Convert blob to data URL (for Safari compatibility)
 */
async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * Create viewer content based on file type
 */
async function createViewer(blob, name, mimeType) {
  const useSafari = isSafariOrIOS()

  // Convert to data URL for Safari, otherwise use blob URL
  const url = useSafari ? await blobToDataURL(blob) : URL.createObjectURL(blob)

  if (mimeType.startsWith('image/')) {
    const img = document.createElement('img')
    img.src = url
    img.className = 'max-w-full max-h-full object-contain'
    img.alt = name
    return { element: img, cleanup: () => !useSafari && URL.revokeObjectURL(url) }
  }

  if (mimeType.startsWith('video/')) {
    const video = document.createElement('video')
    video.src = url
    video.controls = true
    video.playsInline = true // Prevents fullscreen on iOS
    video.className = 'max-w-full max-h-full'
    return { element: video, cleanup: () => !useSafari && URL.revokeObjectURL(url) }
  }

  if (mimeType.startsWith('audio/')) {
    const container = document.createElement('div')
    container.className = 'flex flex-col items-center gap-4 p-8'

    const icon = document.createElement('div')
    icon.className = 'text-6xl'
    icon.textContent = '🎵'

    const fileName = document.createElement('div')
    fileName.className = 'text-lg font-medium text-center break-all'
    fileName.textContent = name

    const audio = document.createElement('audio')
    audio.src = url
    audio.controls = true
    audio.className = 'w-full max-w-md'

    container.append(icon, fileName, audio)
    return { element: container, cleanup: () => !useSafari && URL.revokeObjectURL(url) }
  }

  if (mimeType.startsWith('text/')) {
    const container = document.createElement('div')
    container.className = 'w-full h-full overflow-auto p-4 bg-white'

    const pre = document.createElement('pre')
    pre.className = 'text-sm font-mono whitespace-pre-wrap break-words'

    try {
      const text = await blob.text()
      pre.textContent = text
    } catch (err) {
      pre.textContent = 'Failed to load text content'
    }

    container.appendChild(pre)
    return { element: container, cleanup: () => {} }
  }

  // Unsupported type - show message
  const msg = document.createElement('div')
  msg.className = 'text-center p-8'
  msg.innerHTML = `
    <div class="text-4xl mb-4">📄</div>
    <div class="text-lg font-medium mb-2">${name}</div>
    <div class="text-sm text-gray-600">Preview not available</div>
    <div class="text-xs text-gray-500 mt-1">${mimeType}</div>
  `
  return { element: msg, cleanup: () => {} }
}

/**
 * Show file in modal viewer
 */
export async function showFileViewer(blob, name) {
  const mimeType = guessMime(name)

  // Create modal if it doesn't exist
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'file-viewer-modal'
    modal.className = 'fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4'
    modal.style.display = 'none'
    document.body.appendChild(modal)
  }

  // Clear previous content
  modal.innerHTML = ''
  modal.style.display = 'flex'

  // Close button
  const closeBtn = document.createElement('button')
  closeBtn.className = 'absolute top-4 right-4 text-white text-3xl w-10 h-10 flex items-center justify-center hover:bg-white/20 rounded z-10'
  closeBtn.innerHTML = '&times;'
  closeBtn.setAttribute('aria-label', 'Close')

  // Content container
  const content = document.createElement('div')
  content.className = 'relative max-w-full max-h-full flex items-center justify-center'

  // Create viewer
  const { element, cleanup } = await createViewer(blob, name, mimeType)
  content.appendChild(element)

  modal.appendChild(closeBtn)
  modal.appendChild(content)

  // Close handlers
  const close = () => {
    modal.style.display = 'none'
    cleanup()
  }

  closeBtn.onclick = close
  modal.onclick = (e) => {
    if (e.target === modal) close()
  }

  // Escape key
  const onEscape = (e) => {
    if (e.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onEscape)
    }
  }
  document.addEventListener('keydown', onEscape)
}
