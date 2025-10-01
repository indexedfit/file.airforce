// @ts-check
import { createYDoc, updateManifest, addChatMsg, getChatMessages } from './ydoc.js'
import { ROOM_TOPIC } from './constants.js'
import { renderRoomDetails, renderChatMessages } from './ui.js'
import { getRoom } from './store.js'
import { fetchFileAsBlob, openFile, downloadFile } from './file-manager.js'

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

    // If we've already joined, just return (but allow re-attaching observers)
    const alreadyJoined = joinedRooms.has(roomId)
    if (alreadyJoined) {
    } else {
      joinedRooms.add(roomId)
    }

    // If we have a manifest, we're the host - set it (only on first join)
    if (manifest && !alreadyJoined) {
      updateManifest(ydoc.manifest, manifest)
    }

    // Watch for manifest changes (can be attached multiple times if needed)
    if (onManifestUpdate) {
      const observer = () => {
        const files = ydoc.manifest.get('files') || []
        onManifestUpdate({
          files: files.map(f => ({ ...f })),
          updatedAt: ydoc.manifest.get('updatedAt') || Date.now()
        })
      }
      ydoc.manifest.observe(observer)
      // Trigger initial callback if there's already data
      observer()
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
  }

  setActiveRoom(roomId) {
    this.activeRoomId = roomId;
  }

  getActiveRoom() {
    return this.activeRoomId;
  }

  bindRoomButtons(roomId) {
    const filesUl = document.getElementById("room-files");
    if (filesUl) {
      filesUl.onclick = async (e) => {
        const target = e.target.closest("button[data-action]");
        if (!target) {
          const li = e.target.closest("li[data-idx]");
          if (!li) return;
          filesUl.querySelectorAll("li").forEach((n) => n.classList.remove("is-selected"));
          li.classList.add("is-selected");
          return;
        }
        const action = target.dataset.action;
        const cid = target.dataset.cid;
        const name = target.dataset.name || "file";
        if (!cid) return;
        try {
          const label = action === "open-file" ? "Opening…" : "Downloading…";
          this.onProgress(true, 0, 0, label);
          const blob = await fetchFileAsBlob(this.fs, cid, name, (loaded, total) => {
            this.onProgress(true, loaded, total, `${loaded} bytes`);
          });
          if (action === "open-file") openFile(blob, name);
          else if (action === "download-file") downloadFile(blob, name);
        } catch (err) {
          console.error(err);
        } finally {
          this.onProgress(false);
        }
      };
      filesUl.ondblclick = () => {
        const li = filesUl.querySelector("li.is-selected") || filesUl.querySelector('li[data-idx="0"]');
        if (!li) return;
        const btn = li.querySelector('button[data-action="open-file"]');
        btn?.click();
      };
      filesUl.onkeydown = (e) => {
        const tag = (e.target?.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
        e.preventDefault();
        const items = Array.from(filesUl.querySelectorAll("li[data-idx]"));
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
          const btn = sel.querySelector('button[data-action="open-file"]');
          btn?.click();
        }
      };
      queueMicrotask(() => {
        const first = filesUl.querySelector('li[data-idx="0"]');
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

    const copyBtn = document.getElementById("btn-copy-room-link");
    if (copyBtn) {
      copyBtn.onclick = () => {
        try {
          const link = this.buildInviteURL(roomId);
          navigator.clipboard.writeText(link).then(() => {
            const toast = document.getElementById("toast");
            if (toast) {
              toast.textContent = "Link copied";
              toast.hidden = false;
              setTimeout(() => (toast.hidden = true), 2000);
            }
          });
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
    });
    this.bindRoomButtons(roomId);
    await this.subscribeChat(roomId);
  }

  cleanup() {
    if (this.chatUnsub) this.chatUnsub();
    this.chatUnsub = null;
  }
}
