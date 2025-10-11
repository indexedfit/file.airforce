// @ts-check
import { createYDoc, updateManifest, addChatMsg, getChatMessages } from './ydoc.js'
import { ROOM_TOPIC } from './constants.js'
import { renderRoomDetails, renderChatMessages } from './ui.js'
import { getRoom } from './store.js'
import { fetchFileAsBlob, fetchFileAsBlobWithRetry, openFile, downloadFile } from './file-manager.js'
import { onThumbnailReady } from './thumbnail-events.js'

/**
 * Simplified room manager using Y.js for state sync
 * Y.js handles all manifest + chat synchronization via CRDTs
 * This file only handles lightweight file request signaling
 */

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

/**
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {number=} size
 * @property {string} cid
 */

export function createRoomManager(helia, fs) {
  const libp2p = helia?.libp2p

  // roomId -> Y.Doc (or Promise<Y.Doc>)
  const ydocs = new Map()

  // roomId -> Set<fn> for custom message handlers (file requests, etc)
  const handlers = new Map()

  // Track which rooms we've joined to prevent duplicate joins
  const joinedRooms = new Set()

  // Track observer cleanup functions to prevent duplicates
  const observerCleanups = new Map() // roomId -> [cleanup functions]

  /**
   * Get or create Y.Doc for a room
   * Returns a promise that resolves to the Y.Doc
   */
  async function getYDoc(roomId) {
    if (!ydocs.has(roomId)) {
      const ydocPromise = createYDoc(roomId, libp2p)
      ydocs.set(roomId, ydocPromise)
      const ydoc = await ydocPromise
      ydocs.set(roomId, ydoc) // Replace promise with actual doc
      return ydoc
    }
    const existing = ydocs.get(roomId)
    // Handle case where it's still a promise
    if (existing instanceof Promise) {
      return await existing
    }
    return existing
  }

  /**
   * Subscribe to non-CRDT messages (file requests, etc)
   */
  function subscribe(roomId, handler) {
    const topic = ROOM_TOPIC(roomId)

    let set = handlers.get(roomId)
    if (!set) {
      set = new Set()
      handlers.set(roomId, set)
    }
    set.add(handler)

    const messageHandler = (evt) => {
      if (evt.detail.topic !== topic) return
      try {
        const msg = dec(evt.detail.data)
        // Let Y.js messages be handled by ydoc
        if (msg.type?.startsWith('Y_') || msg.type?.startsWith('SYNC_')) return
        // Call custom handlers for everything else
        for (const fn of set) fn(msg)
      } catch {}
    }

    // Subscribe to topic if not already
    try {
      libp2p.services?.pubsub?.subscribe(topic)
      libp2p.services?.pubsub?.addEventListener('message', messageHandler)
    } catch {}

    return () => {
      set.delete(handler)
      if (set.size === 0) {
        handlers.delete(roomId)
        try {
          libp2p.services?.pubsub?.removeEventListener('message', messageHandler)
          libp2p.services?.pubsub?.unsubscribe(topic)
        } catch {}
      }
    }
  }

  /**
   * Simple publish helper
   */
  async function publish(roomId, msg) {
    const topic = ROOM_TOPIC(roomId)
    try {
      await libp2p.services?.pubsub?.publish(topic, enc({ ...msg, roomId }))
    } catch (err) {
      console.warn('Publish failed:', err)
    }
  }

  /**
   * Request files from peers (hint for bitswap)
   */
  async function requestFiles(roomId, fileCids) {
    await publish(roomId, {
      type: 'FILE_REQUEST',
      cids: fileCids,
      from: libp2p.peerId.toString()
    })
  }

  /**
   * Send chat message via Y.js
   */
  async function sendChat(roomId, text, msgId) {
    const ydoc = await getYDoc(roomId)
    const from = libp2p?.peerId?.toString?.() || 'anon'

    console.log(`[Room ${roomId.slice(0,6)}] Sending chat:`)
    console.log(`  - Full peer ID: ${from}`)
    console.log(`  - libp2p available:`, !!libp2p)
    console.log(`  - peerId available:`, !!libp2p?.peerId)
    console.log(`  - Text: "${text}"`)

    addChatMsg(ydoc.chat, {
      text,
      from,
      ts: Date.now(),
      msgId: msgId || crypto.randomUUID()
    })
  }

  /**
   * Update manifest via Y.js
   */
  async function setManifest(roomId, manifest) {
    const ydoc = await getYDoc(roomId)
    updateManifest(ydoc.manifest, manifest)
  }

  /**
   * Get current manifest from Y.js
   */
  async function getManifest(roomId) {
    const ydoc = await getYDoc(roomId)
    const files = ydoc.manifest.get('files') || []
    return {
      files: files.map(f => ({ ...f })),
      updatedAt: ydoc.manifest.get('updatedAt') || Date.now()
    }
  }

  /**
   * Unified join method - handles both host and joiner cases
   * @param {string} roomId
   * @param {Object=} options
   * @param {any=} options.manifest - Initial manifest (host only)
   * @param {Function=} options.onManifestUpdate - Callback when manifest changes
   * @param {Function=} options.onNewFiles - Callback when new files appear
   */
  async function join(roomId, options = {}) {
    const { manifest, onManifestUpdate, onNewFiles } = options
    const ydoc = await getYDoc(roomId)

    // Clean up old observers before attaching new ones
    if (observerCleanups.has(roomId)) {
      console.log(`[Room ${roomId.slice(0, 6)}] Cleaning up old observers`)
      const cleanups = observerCleanups.get(roomId)
      cleanups.forEach(fn => fn())
      observerCleanups.delete(roomId)
    }

    const cleanups = []
    const alreadyJoined = joinedRooms.has(roomId)

    if (alreadyJoined) {
      console.log(`[Room ${roomId.slice(0, 6)}] Re-joining (observers cleaned)`)
    } else {
      console.log(`[Room ${roomId.slice(0, 6)}] First join`)
      joinedRooms.add(roomId)
    }

    // If we have a manifest, we're the host - set it (only on first join)
    if (manifest && !alreadyJoined) {
      console.log(`[Room ${roomId.slice(0, 6)}] Setting initial manifest as host (${manifest.files?.length || 0} files)`)
      updateManifest(ydoc.manifest, manifest)
    }

    // Watch for manifest changes
    if (onManifestUpdate) {
      const observer = () => {
        const files = ydoc.manifest.get('files') || []
        console.log(`[Room ${roomId.slice(0, 6)}] Manifest observer fired, ${files.length} files:`, files.map(f => f.name))
        const manifestObj = {
          files: files.map(f => ({ ...f })),
          updatedAt: ydoc.manifest.get('updatedAt') || Date.now()
        }
        console.log(`[Room ${roomId.slice(0, 6)}] Calling onManifestUpdate callback with:`, manifestObj)
        onManifestUpdate(manifestObj)
      }
      ydoc.manifest.observe(observer)
      cleanups.push(() => ydoc.manifest.unobserve(observer))
      observer() // Trigger initial
    }

    // Watch for new files (auto-pin)
    if (onNewFiles) {
      let prevFiles = new Set((ydoc.manifest.get('files') || []).map(f => f.cid))
      const observer = () => {
        const files = ydoc.manifest.get('files') || []
        const currentFiles = new Set(files.map(f => f.cid))
        const newCids = [...currentFiles].filter(cid => !prevFiles.has(cid))
        if (newCids.length > 0) {
          onNewFiles(newCids)
          prevFiles = currentFiles
        }
      }
      ydoc.manifest.observe(observer)
      cleanups.push(() => ydoc.manifest.unobserve(observer))
    }

    // Handle file requests (for all peers) - only on first join
    if (!alreadyJoined) {
      subscribe(roomId, async (msg) => {
        if (msg.type === 'FILE_REQUEST') {
          for (const cid of msg.cids || []) {
            try {
              for await (const _ of helia.pin.add(cid)) {}
            } catch {}
          }
        }
      })
    }

    // Store cleanup functions
    if (cleanups.length > 0) {
      observerCleanups.set(roomId, cleanups)
    }

    return ydoc
  }

  /**
   * Destroy a room's Y.Doc
   */
  function destroyRoom(roomId) {
    const ydoc = ydocs.get(roomId)
    if (ydoc && typeof ydoc.destroy === 'function') {
      ydoc.destroy()
    }
    ydocs.delete(roomId)
    handlers.delete(roomId)
    joinedRooms.delete(roomId)
  }

  return {
    getYDoc,
    subscribe,
    publish,
    requestFiles,
    sendChat,
    setManifest,
    getManifest,
    join,
    destroyRoom
  }
}

/**
 * Room UI management: rendering, event binding, subscriptions
 */
export class RoomUI {
  constructor({ rooms, fs, libp2p, helia, onProgress }) {
    this.rooms = rooms;
    this.fs = fs;
    this.libp2p = libp2p;
    this.helia = helia;
    this.onProgress = onProgress;
    this.activeRoomId = null;
    this.chatUnsub = null;
    this.thumbnailUnsub = null;
    this.thumbnails = {}; // cid -> data URL
    this.viewMode = localStorage.getItem('room-view-mode') || 'list'; // Persist preference
  }

  setActiveRoom(roomId) {
    this.activeRoomId = roomId;
  }

  getActiveRoom() {
    return this.activeRoomId;
  }

  bindRoomButtons(roomId) {
    // View mode toggle buttons
    const btnList = document.getElementById("btn-view-list");
    const btnGrid = document.getElementById("btn-view-grid");
    if (btnList) {
      btnList.onclick = () => {
        this.viewMode = 'list';
        localStorage.setItem('room-view-mode', 'list');
        this.render(roomId);
      };
    }
    if (btnGrid) {
      btnGrid.onclick = () => {
        this.viewMode = 'grid';
        localStorage.setItem('room-view-mode', 'grid');
        this.render(roomId);
      };
    }

    const filesUl = document.getElementById("room-files");
    if (filesUl) {
      // Helper to open file with navigation
      const openFileWithNav = async (idx) => {
        const manifest = await this.rooms.getManifest(roomId);
        const files = manifest?.files || [];
        if (idx < 0 || idx >= files.length) return;

        const file = files[idx];
        console.log(`[Room] ========== OPENING FILE ==========`);
        console.log(`[Room] File index: ${idx}`);
        console.log(`[Room] File details:`, {
          name: file.name,
          cid: file.cid,
          size: file.size
        });

        this.onProgress(true, 0, 0, "Opening…");
        try {
          // Use direct fetch for opening (no retry - should work immediately)
          const blob = await fetchFileAsBlob(this.fs, file.cid, file.name, (loaded, total) => {
            this.onProgress(true, loaded, total, `${loaded} bytes`);
          });

          console.log(`[Room] ✓ Blob fetched successfully`);
          console.log(`[Room] Blob before viewer:`, {
            size: blob.size,
            type: blob.type,
            constructor: blob.constructor.name
          });

          // Import and call showFileViewer with navigation
          const { showFileViewer } = await import('./file-viewer.js');
          console.log(`[Room] Calling showFileViewer...`);
          await showFileViewer(blob, file.name, {
            currentIndex: idx,
            totalFiles: files.length,
            onNext: () => {
              if (idx < files.length - 1) openFileWithNav(idx + 1);
            },
            onPrev: () => {
              if (idx > 0) openFileWithNav(idx - 1);
            }
          });
        } catch (err) {
          console.error(`Failed to open ${file.name}:`, err);
          const toast = document.getElementById("toast");
          if (toast) {
            toast.textContent = `Failed to open file: ${err.message || 'Unknown error'}`;
            toast.hidden = false;
            setTimeout(() => (toast.hidden = true), 3000);
          }
        } finally {
          this.onProgress(false);
        }
      };

      filesUl.onclick = async (e) => {
        const target = e.target.closest("button[data-action]");

        // Handle download button
        if (target?.dataset.action === "download-file") {
          const cid = target.dataset.cid;
          const name = target.dataset.name || "file";
          if (!cid) return;
          try {
            this.onProgress(true, 0, 0, "Downloading…");
            const blob = await fetchFileAsBlobWithRetry(this.fs, cid, name, (loaded, total) => {
              this.onProgress(true, loaded, total, `${loaded} bytes`);
            });
            downloadFile(blob, name);
          } catch (err) {
            console.error(err);
          } finally {
            this.onProgress(false);
          }
          return;
        }

        // Single-click on list item or "Open" button opens file with navigation
        const clickedItem = e.target.closest("[data-idx]");
        const openButton = target?.dataset.action === "open-file";

        if (clickedItem || openButton) {
          const item = clickedItem || target.closest("[data-idx]");
          if (!item) return;

          const idx = parseInt(item.dataset.idx, 10);
          if (isNaN(idx)) return;

          // Update selection
          filesUl.querySelectorAll("[data-idx]").forEach((n) => n.classList.remove("is-selected"));
          item.classList.add("is-selected");

          // Open file with navigation
          await openFileWithNav(idx);
        }
      };

      filesUl.onkeydown = (e) => {
        const tag = (e.target?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
        e.preventDefault();
        const items = Array.from(filesUl.querySelectorAll("[data-idx]"));
        if (!items.length) return;
        let idx = items.findIndex((n) => n.classList.contains("is-selected"));
        if (idx < 0) idx = 0;
        if (e.key === "ArrowDown") idx = Math.min(items.length - 1, idx + 1);
        if (e.key === "ArrowUp") idx = Math.max(0, idx - 1);
        items.forEach((n) => n.classList.remove("is-selected"));
        const sel = items[idx];
        sel.classList.add("is-selected");
        sel.focus();
        if (e.key === "Enter") {
          const fileIdx = parseInt(sel.dataset.idx, 10);
          if (!isNaN(fileIdx)) {
            openFileWithNav(fileIdx);
          }
        }
      };
      queueMicrotask(() => {
        const first = filesUl.querySelector('[data-idx="0"]');
        if (first) first.classList.add("is-selected");
      });
    }

    const input = document.getElementById("chat-input");
    const send = document.getElementById("btn-chat-send");
    if (send && input) {
      const sendNow = async () => {
        const text = input.value.trim();
        if (!text) return;
        const mid = crypto.randomUUID();
        this.rooms.sendChat(roomId, text, mid).catch(() => {});
        input.value = "";
      };
      send.onclick = sendNow;
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          sendNow();
        }
      };
    }

    const shareBtn = document.getElementById("btn-share-room");
    if (shareBtn) {
      shareBtn.onclick = () => {
        try {
          const link = this.buildInviteURL(roomId);
          this.showRoomQR(link);
        } catch (e) {
          console.error(e);
        }
      };
    }
  }

  buildInviteURL(roomId) {
    const u = new URL(location.href);
    u.searchParams.set("view", "rooms");
    u.searchParams.set("room", roomId);
    return u.toString();
  }

  async showRoomQR(link) {
    // Import QRCode dynamically if needed
    const QRCode = (await import('qrcode')).default;

    // Create or show QR modal
    let modal = document.getElementById("room-qr-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "room-qr-modal";
      modal.className = "fixed inset-0 bg-black/50 flex items-center justify-center z-50";
      modal.innerHTML = `
        <div class="bg-white rounded-lg p-6 max-w-sm mx-4 relative">
          <button id="close-qr-modal" class="absolute top-2 right-2 text-gray-500 hover:text-gray-700 text-2xl leading-none">&times;</button>
          <h3 class="font-semibold mb-3">Share room</h3>
          <canvas id="room-qr-canvas" class="w-full border rounded mb-3"></canvas>
          <div class="text-sm text-gray-600 break-all mb-2">${link}</div>
          <button id="copy-qr-link" class="w-full px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">Copy link</button>
        </div>
      `;
      document.body.appendChild(modal);
    }

    // Update link text
    modal.querySelector(".text-sm").textContent = link;

    // Generate QR code
    const canvas = modal.querySelector("#room-qr-canvas");
    try {
      await QRCode.toCanvas(canvas, link, { width: 256, margin: 1 });
    } catch (err) {
      console.error("QR generation failed:", err);
    }

    // Show modal
    modal.classList.remove("hidden");

    // Bind close button
    modal.querySelector("#close-qr-modal").onclick = () => {
      modal.classList.add("hidden");
    };

    // Close on backdrop click
    modal.onclick = (e) => {
      if (e.target === modal) {
        modal.classList.add("hidden");
      }
    };

    // Bind copy button
    modal.querySelector("#copy-qr-link").onclick = () => {
      navigator.clipboard.writeText(link).then(() => {
        const btn = modal.querySelector("#copy-qr-link");
        const originalText = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = originalText;
        }, 2000);
      });
    };
  }

  async subscribeChat(roomId) {
    if (this.chatUnsub) {
      this.chatUnsub();
      this.chatUnsub = null;
    }
    const ydoc = await this.rooms.getYDoc(roomId);
    const observer = () => {
      if (roomId === this.activeRoomId) {
        const messages = getChatMessages(ydoc.chat);
        renderChatMessages(messages, this.libp2p.peerId.toString());
      }
    };
    ydoc.chat.observe(observer);
    this.chatUnsub = () => ydoc.chat.unobserve(observer);
    observer();
  }

  async render(roomId) {
    this.activeRoomId = roomId;
    const room = getRoom(roomId);
    const manifest = room?.manifest || (await this.rooms.getManifest(roomId));
    renderRoomDetails({
      id: roomId,
      name: room?.name || `Room ${roomId.slice(0, 6)}`,
      manifest,
    }, { thumbnails: this.thumbnails, viewMode: this.viewMode });
    this.bindRoomButtons(roomId);
    await this.subscribeChat(roomId);
    this.subscribeThumbnails(roomId);
  }

  subscribeThumbnails(roomId) {
    if (this.thumbnailUnsub) {
      this.thumbnailUnsub();
      this.thumbnailUnsub = null;
    }

    this.thumbnailUnsub = onThumbnailReady(roomId, (cid, dataUrl) => {
      // Store thumbnail
      this.thumbnails[cid] = dataUrl;

      // Update just the specific file's thumbnail in the DOM
      if (roomId === this.activeRoomId) {
        // Works for both list and grid views
        const element = document.querySelector(`#room-files [data-cid="${cid}"]`);
        if (element) {
          const existingThumb = element.querySelector('img, div.w-10, div.w-full');
          if (existingThumb) {
            const newThumb = document.createElement('img');
            newThumb.src = dataUrl;
            // Different sizes for list vs grid
            if (this.viewMode === 'grid') {
              newThumb.className = 'w-full h-32 object-cover rounded-t';
            } else {
              newThumb.className = 'w-10 h-10 object-cover rounded border flex-shrink-0';
            }
            existingThumb.replaceWith(newThumb);
          }
        }
      }
    });
  }

  cleanup() {
    if (this.chatUnsub) this.chatUnsub();
    this.chatUnsub = null;
    if (this.thumbnailUnsub) this.thumbnailUnsub();
    this.thumbnailUnsub = null;
  }
}
