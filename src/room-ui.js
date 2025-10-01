// @ts-check
/**
 * Room UI management: rendering, event binding, subscriptions
 * Extracted from bootstrap.js for clarity
 */

import { getChatMessages } from "./ydoc.js";
import { renderRoomDetails, renderChatMessages } from "./ui.js";
import { getRoom } from "./store.js";
import { fetchFileAsBlob, openFile, downloadFile } from "./file-manager.js";

export class RoomUI {
  constructor({ rooms, fs, libp2p, helia, onProgress }) {
    this.rooms = rooms;
    this.fs = fs;
    this.libp2p = libp2p;
    this.helia = helia;
    this.onProgress = onProgress;
    this.activeRoomId = null;
    this.chatUnsub = null;
    this.manifestUnsub = null;
  }

  setActiveRoom(roomId) {
    this.activeRoomId = roomId;
  }

  getActiveRoom() {
    return this.activeRoomId;
  }

  /**
   * Bind all room button handlers (chat, file actions, etc)
   */
  bindRoomButtons(roomId) {
    // File list interactions
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

    // Chat input
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

    // Copy room link
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
    u.searchParams.set("host", this.libp2p.peerId.toString());
    const tr = globalThis.wcInviteExtras?.tracker || "";
    if (tr) u.searchParams.set("tracker", encodeURIComponent(tr));
    return u.toString();
  }

  /**
   * Subscribe to chat updates for a room
   */
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

  /**
   * Subscribe to manifest updates for a room
   * Note: This is now handled by onManifestUpdate callback in rooms.join()
   * Keeping this for potential future use
   */
  async subscribeManifest(roomId, onUpdate) {
    if (this.manifestUnsub) {
      this.manifestUnsub();
      this.manifestUnsub = null;
    }
    const ydoc = await this.rooms.getYDoc(roomId);
    const observer = async () => {
      await onUpdate(roomId);
    };
    ydoc.manifest.observe(observer);
    this.manifestUnsub = () => ydoc.manifest.unobserve(observer);
    // Don't call observer() immediately - let onManifestUpdate handle initial render
  }

  /**
   * Render a room and set up all handlers
   */
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

  /**
   * Clean up subscriptions
   */
  cleanup() {
    if (this.chatUnsub) this.chatUnsub();
    if (this.manifestUnsub) this.manifestUnsub();
    this.chatUnsub = null;
    this.manifestUnsub = null;
  }
}
