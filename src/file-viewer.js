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
 * Must match thumbnail-cache.js detection exactly
 */
function isSafariOrIOS() {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || /^((?!chrome|android).)*safari/i.test(ua)
}

/**
 * Convert blob to data URL (for Safari compatibility)
 * Safari iOS can't reliably display blob URLs in img/video/audio tags
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
  // iOS Safari fix: Always ensure blob has correct MIME type
  // Safari is strict about MIME types and can drop them during blob operations
  console.log(`[FileViewer] Creating viewer for ${name}: blob.type="${blob.type}", expected="${mimeType}", size=${blob.size}`)

  if (blob.type !== mimeType) {
    console.log(`[FileViewer] MIME type mismatch - recreating blob with correct type`)
    blob = new Blob([blob], { type: mimeType })
    console.log(`[FileViewer] After recreate: blob.type="${blob.type}", size=${blob.size}`)
  }

  // Debug: Check if blob bytes are valid
  console.log(`[FileViewer] Testing blob data integrity...`);
  const testBytes = await blob.arrayBuffer();
  console.log(`[FileViewer] Blob arrayBuffer size: ${testBytes.byteLength}`);
  const firstBytes = new Uint8Array(testBytes, 0, Math.min(20, testBytes.byteLength));
  console.log(`[FileViewer] First 20 bytes:`, Array.from(firstBytes).map(b => b.toString(16).padStart(2, '0')).join(' '));

  // PNG should start with: 89 50 4e 47 0d 0a 1a 0a
  // JPEG should start with: ff d8 ff
  const isPNG = firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4e && firstBytes[3] === 0x47;
  const isJPEG = firstBytes[0] === 0xff && firstBytes[1] === 0xd8 && firstBytes[2] === 0xff;
  console.log(`[FileViewer] Valid PNG header: ${isPNG}, Valid JPEG header: ${isJPEG}`);

  // Use blob URLs for all browsers
  const url = URL.createObjectURL(blob)
  console.log(`[FileViewer] Created URL: ${url.substring(0, 50)}...`)

  if (mimeType.startsWith('image/')) {
    console.log(`[FileViewer] Creating image element...`);
    const img = document.createElement('img')

    // Add error handler BEFORE setting src
    img.onerror = (e) => {
      console.error(`[FileViewer] ✗✗✗ IMAGE FAILED TO LOAD ✗✗✗`);
      console.error(`[FileViewer] Error event:`, e);
      console.error(`[FileViewer] Image src:`, img.src);
      console.error(`[FileViewer] Blob type:`, blob.type);
      console.error(`[FileViewer] Blob size:`, blob.size);
      console.error(`[FileViewer] Expected MIME:`, mimeType);
      console.error(`[FileViewer] URL:`, url);
    }
    img.onload = () => {
      console.log(`[FileViewer] ✓✓✓ IMAGE LOADED SUCCESSFULLY ✓✓✓`);
      console.log(`[FileViewer] Image:`, {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        src: img.src.substring(0, 100) + '...'
      });
    }

    img.src = url
    img.className = 'max-w-full max-h-full object-contain'
    img.alt = name
    console.log(`[FileViewer] Image src set to: ${url.substring(0, 100)}...`);

    return { element: img, cleanup: () => URL.revokeObjectURL(url) }
  }

  if (mimeType.startsWith('video/')) {
    const video = document.createElement('video')
    video.src = url
    video.controls = true
    video.playsInline = true // Prevents fullscreen on iOS
    video.className = 'max-w-full max-h-full'
    return { element: video, cleanup: () => URL.revokeObjectURL(url) }
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
    return { element: container, cleanup: () => URL.revokeObjectURL(url) }
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
 * Show file in modal viewer with navigation support
 * @param {Blob} blob - File blob to display
 * @param {string} name - File name
 * @param {Object} options - Navigation options
 * @param {Function} options.onNext - Callback for next file
 * @param {Function} options.onPrev - Callback for previous file
 * @param {number} options.currentIndex - Current file index
 * @param {number} options.totalFiles - Total number of files
 */
export async function showFileViewer(blob, name, options = {}) {
  console.log(`[showFileViewer] ========== SHOW FILE VIEWER ==========`);
  console.log(`[showFileViewer] Input blob:`, {
    name: name,
    size: blob.size,
    type: blob.type,
    constructor: blob.constructor.name
  });

  const { onNext, onPrev, currentIndex, totalFiles } = options
  const mimeType = guessMime(name)
  console.log(`[showFileViewer] Guessed MIME type: "${mimeType}"`);

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

  // Navigation buttons
  const showNav = onNext && onPrev && totalFiles > 1
  let prevBtn, nextBtn, counter

  if (showNav) {
    prevBtn = document.createElement('button')
    prevBtn.className = 'absolute left-4 top-1/2 -translate-y-1/2 text-white text-4xl w-12 h-12 flex items-center justify-center hover:bg-white/20 rounded z-10'
    prevBtn.innerHTML = '‹'
    prevBtn.setAttribute('aria-label', 'Previous file')
    prevBtn.onclick = onPrev

    nextBtn = document.createElement('button')
    nextBtn.className = 'absolute right-4 top-1/2 -translate-y-1/2 text-white text-4xl w-12 h-12 flex items-center justify-center hover:bg-white/20 rounded z-10'
    nextBtn.innerHTML = '›'
    nextBtn.setAttribute('aria-label', 'Next file')
    nextBtn.onclick = onNext

    counter = document.createElement('div')
    counter.className = 'absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm bg-black/50 px-3 py-1 rounded'
    counter.textContent = `${currentIndex + 1} / ${totalFiles}`
  }

  // Content container
  const content = document.createElement('div')
  content.className = 'relative w-full h-full flex items-center justify-center'

  // Create viewer
  const { element, cleanup } = await createViewer(blob, name, mimeType)
  content.appendChild(element)

  modal.appendChild(closeBtn)
  if (showNav) {
    modal.appendChild(prevBtn)
    modal.appendChild(nextBtn)
    modal.appendChild(counter)
  }
  modal.appendChild(content)

  // Close handlers
  const close = () => {
    modal.style.display = 'none'
    cleanup()
    document.removeEventListener('keydown', onKeyDown)
  }

  closeBtn.onclick = close
  modal.onclick = (e) => {
    if (e.target === modal) close()
  }

  // Keyboard navigation
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      close()
    } else if (e.key === 'ArrowLeft' && onPrev) {
      onPrev()
    } else if (e.key === 'ArrowRight' && onNext) {
      onNext()
    }
  }
  document.addEventListener('keydown', onKeyDown)

  // Touch swipe navigation
  if (showNav) {
    let touchStartX = 0
    let touchEndX = 0

    content.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX
    }, { passive: true })

    content.addEventListener('touchend', (e) => {
      touchEndX = e.changedTouches[0].screenX
      const diff = touchStartX - touchEndX
      const threshold = 50 // Minimum swipe distance

      if (Math.abs(diff) > threshold) {
        if (diff > 0 && onNext) {
          // Swipe left - next file
          onNext()
        } else if (diff < 0 && onPrev) {
          // Swipe right - previous file
          onPrev()
        }
      }
    }, { passive: true })
  }
}
