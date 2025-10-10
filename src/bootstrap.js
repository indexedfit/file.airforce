import QRCode from "qrcode";
import { startHelia } from "./heliaNode.js";
import { createRoomManager } from "./room.js";
import { WebRTC, WebSockets, WebSocketsSecure, WebTransport, Circuit, WebRTCDirect } from '@multiformats/multiaddr-matcher';

// Simple routing
const views = ['home', 'drops', 'rooms', 'peers'];
function currentView() {
  const sp = new URLSearchParams(location.search);
  const v = sp.get('view');
  return views.includes(v) ? v : 'home';
}
function goto(view, extras = {}) {
  if (view === 'home' && Object.keys(extras).length === 0) {
    history.pushState(null, '', '/');
    renderView();
    return;
  }
  const sp = new URLSearchParams();
  sp.set('view', view);
  for (const [k, v] of Object.entries(extras)) if (v != null) sp.set(k, v);
  history.pushState(null, '', `?${sp.toString()}`);
  renderView();
}
function renderView() {
  const v = currentView();
  for (const name of views) {
    const el = document.getElementById(`view-${name}`);
    if (el) el.hidden = name !== v;
  }
}
function bindNavLinks() {
  document.querySelectorAll('a[data-link]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = new URL(a.href);
      goto(url.searchParams.get('view') || 'home');
    });
  });
  window.addEventListener('popstate', renderView);
}
import {
  renderAddresses,
  renderPeerTypes,
  renderPeerDetails,
  renderDrops,
  toast,
  setPeerId,
  setConnCount,
  showCreateRoomPanel,
  showUploadProgress,
  updateProgress,
  renderRoomsList,
} from "./ui.js";
import {
  saveDrop,
  getDrops,
  saveRoom,
  getRoom,
  getRooms,
} from "./store.js";
import { addFilesAndCreateManifest, formatBytes } from "./file-manager.js";
import { MIRROR_URL } from "./constants.js";

// Peer info helpers
function listAddresses(libp2p) {
  return libp2p.getMultiaddrs().map(ma => ma.toString());
}
function countPeerTypes(libp2p) {
  const t = { 'Circuit Relay': 0, WebRTC: 0, 'WebRTC Direct': 0, WebSockets: 0, 'WebSockets (secure)': 0, WebTransport: 0, Other: 0 };
  libp2p.getConnections().map(c => c.remoteAddr).forEach((ma) => {
    if (WebRTC.exactMatch(ma)) t['WebRTC']++;
    else if (WebRTCDirect.exactMatch(ma)) t['WebRTC Direct']++;
    else if (WebSockets.exactMatch(ma)) t['WebSockets']++;
    else if (WebSocketsSecure.exactMatch(ma)) t['WebSockets (secure)']++;
    else if (WebTransport.exactMatch(ma)) t['WebTransport']++;
    else if (Circuit.exactMatch(ma)) t['Circuit Relay']++;
    else t['Other']++;
  });
  return t;
}
function peerDetails(libp2p) {
  return libp2p.getPeers().map(peer => {
    const conns = libp2p.getConnections(peer);
    return { id: peer.toString(), addrs: conns.map(c => c.remoteAddr.toString()) };
  });
}
import { RoomUI } from "./room.js";

const $ = (id) => document.getElementById(id);

let helia, fs, libp2p, rooms;
let roomUI;


function showFetchProgress(show, loaded = 0, total = 0, label = "") {
  showUploadProgress(show);
  const pct =
    total > 0 ? Math.round((loaded / total) * 100) : loaded > 0 ? 5 + (loaded % 50) : 0;
  updateProgress(pct, label);
}

function randId() {
  return crypto.randomUUID?.() || Math.random().toString(36).slice(2);
}

function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}

function randomSlug() {
  const adjs = [
    "brave",
    "calm",
    "daring",
    "eager",
    "fancy",
    "gentle",
    "happy",
    "icy",
    "jolly",
    "kind",
    "lively",
    "merry",
    "nifty",
    "polite",
    "quick",
    "royal",
    "sunny",
    "tidy",
    "witty",
    "zesty",
  ];
  const nouns = [
    "otter",
    "panda",
    "fox",
    "llama",
    "koala",
    "eagle",
    "lion",
    "tiger",
    "whale",
    "falcon",
    "yak",
    "zebra",
    "owl",
    "deer",
    "rhino",
    "hippo",
    "gecko",
    "seal",
    "wolf",
    "sparrow",
  ];
  return `${pick(adjs)}-${pick(nouns)}`;
}

function buildInviteURL(roomId) {
  const u = new URL(location.href);
  u.searchParams.set("view", "rooms");
  u.searchParams.set("room", roomId);
  return u.toString();
}

function showInvite(link) {
  const out = $("invite-output");
  out.classList.remove("hidden");
  const input = $("invite-link");
  input.value = link;
  $("btn-copy-invite").onclick = () => {
    navigator.clipboard.writeText(link).then(() => toast("Copied invite link"));
  };
  const canvas = $("invite-qr");
  QRCode.toCanvas(canvas, link, { margin: 1 }, (err) => {
    if (err) console.error(err);
  });
}



export async function startUI() {
  ({ helia, fs, libp2p } = await startHelia());
  rooms = createRoomManager(helia, fs);

  // Initialize room UI manager
  roomUI = new RoomUI({
    rooms,
    fs,
    libp2p,
    helia,
    onProgress: showFetchProgress,
  });

  // Set up event delegation for room file inputs (robust to re-renders)
  const roomsInfo = document.getElementById('rooms-info');
  if (roomsInfo) {
    // Browse button click
    roomsInfo.addEventListener('click', (e) => {
      if (e.target.id === 'btn-room-browse') {
        const input = document.getElementById('room-file-input');
        if (input) input.click();
      }
    });

    // File input change
    roomsInfo.addEventListener('change', (e) => {
      if (e.target.id === 'room-file-input') {
        const rid = roomUI.getActiveRoom();
        if (rid && e.target.files && e.target.files.length > 0) {
          handleRoomFiles(rid, e.target.files);
        }
      }
    });

    // Drag & drop
    roomsInfo.addEventListener('dragover', (e) => {
      if (e.target.id === 'room-dropzone' || e.target.closest('#room-dropzone')) {
        e.preventDefault();
        const dropzone = document.getElementById('room-dropzone');
        if (dropzone) dropzone.classList.add('bg-gray-100');
      }
    });

    roomsInfo.addEventListener('dragleave', (e) => {
      if (e.target.id === 'room-dropzone') {
        e.target.classList.remove('bg-gray-100');
      }
    });

    roomsInfo.addEventListener('drop', (e) => {
      if (e.target.id === 'room-dropzone' || e.target.closest('#room-dropzone')) {
        e.preventDefault();
        const dropzone = document.getElementById('room-dropzone');
        if (dropzone) dropzone.classList.remove('bg-gray-100');
        const rid = roomUI.getActiveRoom();
        if (rid && e.dataTransfer.files) {
          handleRoomFiles(rid, e.dataTransfer.files);
        }
      }
    });
  }

  setPeerId(libp2p.peerId.toString());

  // Update peer info periodically
  setInterval(() => {
    setConnCount(libp2p.getConnections().length);
    renderAddresses(listAddresses(libp2p));
  }, 1000);
  setInterval(() => {
    renderPeerTypes(countPeerTypes(libp2p));
    renderPeerDetails(peerDetails(libp2p));
  }, 1500);

  bindNavLinks();
  renderView();
  renderRoomsIfActive();

  // Peer info toggle
  const toggle = document.getElementById("peer-info-toggle");
  const panel = document.getElementById("peer-info-panel");
  if (toggle && panel) toggle.onclick = () => panel.classList.toggle("hidden");

  // Global error handlers
  window.addEventListener("unhandledrejection", (e) => {
    console.error("Unhandled rejection", e.reason);
    toast(e?.reason?.message || "Unexpected error");
  });
  window.addEventListener("error", (e) => {
    console.error("Error", e.error || e.message);
    toast(e?.error?.message || e.message || "Error");
  });

  // File upload UI
  const dropzone = $("dropzone");
  const fileInput = $("file-input");
  const browse = $("btn-browse");

  console.log('[startUI] Elements:', {
    dropzone: !!dropzone,
    fileInput: !!fileInput,
    browse: !!browse
  });

  let selectedFiles = [];
  function renderSelectedFiles() {
    const panel = $("selected-files-panel");
    const ul = $("selected-file-list");
    if (!panel || !ul) return;
    panel.classList.toggle("hidden", selectedFiles.length === 0);
    const frag = document.createDocumentFragment();
    selectedFiles.forEach((f, idx) => {
      const li = document.createElement("li");
      li.className = "py-1 flex items-center gap-2";
      const name = document.createElement("span");
      name.className = "flex-1 truncate";
      name.textContent = `${f.name} (${f.size} bytes)`;
      const rm = document.createElement("button");
      rm.className = "px-2 py-0.5 text-xs border rounded";
      rm.textContent = "Remove";
      rm.onclick = () => {
        selectedFiles.splice(idx, 1);
        renderSelectedFiles();
      };
      li.append(name, rm);
      frag.appendChild(li);
    });
    ul.replaceChildren(frag);
  }

  if (browse) browse.onclick = () => fileInput.click();
  if (dropzone) {
    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.classList.add("bg-white");
    };
    dropzone.ondragleave = () => dropzone.classList.remove("bg-white");
  }

  async function handleSelectedFiles(files) {
    const key = (f) => `${f.name}:${f.size}:${f.lastModified ?? 0}`;
    const seen = new Set(selectedFiles.map(key));
    for (const f of Array.from(files || [])) {
      const k = key(f);
      if (!seen.has(k)) {
        selectedFiles.push(f);
        seen.add(k);
      }
    }
    showCreateRoomPanel(selectedFiles.length > 0);
    renderSelectedFiles();

    // Auto-create room if not joining
    if (!isJoinContext() && selectedFiles.length) {
      await autoCreateDropAndRoom();
    }
  }

  if (dropzone) {
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove("bg-white");
      handleSelectedFiles(e.dataTransfer.files);
    };
  }
  if (fileInput) fileInput.onchange = () => handleSelectedFiles(fileInput.files);

  let creationInFlight = false;

  function isJoinContext() {
    const sp = new URLSearchParams(location.search);
    return !!sp.get("room");
  }

  async function autoCreateDropAndRoom() {
    if (creationInFlight || !selectedFiles.length) return;
    creationInFlight = true;
    try {
      toast(`Adding ${selectedFiles.length} file(s)…`);
      const manifest = await addFilesAndCreateManifest(fs, selectedFiles, (done, total) => {
        showUploadProgress(true);
        updateProgress(Math.round((done / total) * 100), `${done}/${total}`);
      });
      showUploadProgress(false);

      const defaultName = $("drop-name")?.value?.trim() || randomSlug();
      const drop = {
        id: randId(),
        name: defaultName,
        createdAt: Date.now(),
        files: manifest.files,
      };

      // Pin files locally
      for (const f of manifest.files) {
        try {
          for await (const _ of helia.pin.add(f.cid)) {}
        } catch {}
      }

      // Upload blocks to mirror
      if (manifest.files.length > 0) {
        try {
          console.log(`[Mirror] Starting upload for ${manifest.files.length} files to ${MIRROR_URL}`);
          const blocks = [];
          const seen = new Set();

          for (const file of manifest.files) {
            console.log(`[Mirror] Collecting blocks for ${file.name} (${file.cid})`);
            const queue = [file.cid];

            while (queue.length > 0) {
              const cidStr = queue.shift();
              if (seen.has(cidStr)) continue;
              seen.add(cidStr);

              try {
                // Parse CID string to CID object
                const { CID } = await import('multiformats/cid');
                const cid = CID.parse(cidStr);
                const bytes = await helia.blockstore.get(cid);

                // Convert Uint8Array to base64 without stack overflow
                let binary = '';
                for (let i = 0; i < bytes.length; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                blocks.push({
                  cid: cidStr,
                  bytes: btoa(binary)
                });

                // Try to parse as dag-pb to find links
                try {
                  const { decode } = await import('@ipld/dag-pb');
                  const block = decode(bytes);
                  if (block.Links) {
                    for (const link of block.Links) {
                      if (link.Hash) {
                        queue.push(link.Hash.toString());
                      }
                    }
                  }
                } catch {
                  // Not dag-pb or no links, that's ok
                }
              } catch (err) {
                console.error(`[Mirror] Failed to get block ${cidStr}:`, err);
              }
            }
          }

          if (blocks.length > 0) {
            console.log(`[Mirror] Uploading ${blocks.length} blocks for ${manifest.files.length} files...`);
            const response = await fetch(MIRROR_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ blocks })
            });

            if (!response.ok) {
              console.error(`[Mirror] Upload failed with status ${response.status}`);
              const text = await response.text();
              console.error('[Mirror] Response:', text);
            } else {
              const result = await response.json();
              console.log(`[Mirror] Upload complete: ${result.stored?.length || 0} stored, ${result.failed?.length || 0} failed`);
            }
          } else {
            console.warn('[Mirror] No blocks collected!');
          }
        } catch (err) {
          console.error('[Mirror] Upload error:', err);
        }
      }


      const room = {
        id: randId(),
        name: $("room-name")?.value?.trim() || defaultName,
        manifest,
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };

      saveDrop({ ...drop, roomId: room.id });
      saveRoom(room);

      // Join as host
      await rooms.join(room.id, { manifest });

      renderDrops(getDrops().slice(0, 5), "drops-list");

      // Navigate to room
      goto("rooms", { room: room.id });

      await renderRoomsIfActive();
      toast("Room created and files pinned locally");
    } catch (err) {
      console.error("autoCreate failed", err);
      toast("Failed to create drop/room");
    } finally {
      creationInFlight = false;
    }
  }

  renderDrops(getDrops().slice(0, 5), "drops-list");
  renderDrops(getDrops(), "drops-list-full");

  // Join room button
  const joinBtn = $("btn-join-room");
  if (joinBtn) {
    joinBtn.onclick = async () => {
      const inputEl = $("join-room-id");
      const input = (inputEl?.value || "").trim();
      if (!input) return;
      let roomId = input;
      try {
        const u = new URL(input);
        roomId = u.searchParams.get("room") || input;
      } catch { }
      const existing = getRoom(roomId);
      if (!existing)
        saveRoom({
          id: roomId,
          name: `Room ${roomId.slice(0, 6)}`,
          createdAt: Date.now(),
          lastSeen: Date.now(),
        });

      await rooms.join(roomId, {
        onManifestUpdate: async (manifest) => {
          const room = getRoom(roomId);
          saveRoom({
            id: roomId,
            name: room?.name || `Room ${roomId.slice(0, 6)}`,
            manifest,
            lastSeen: Date.now()
          });
          updateRoomsList();
        },
      });

      goto("rooms", { room: roomId });
      await renderRoomsIfActive();
      toast(`Joined room ${roomId}`);
    };
  }

  // Handle adding files to existing room
  async function handleRoomFiles(roomId, files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    try {
      const added = await addFilesAndCreateManifest(fs, arr, (done, total) => {
        showUploadProgress(true);
        updateProgress(Math.round((done / total) * 100), `${done}/${total}`);
      });
      showUploadProgress(false);

      const cur = getRoom(roomId)?.manifest || { files: [] };
      const byCid = new Map(cur.files.map((f) => [f.cid, f]));
      for (const f of added.files) byCid.set(f.cid, f);
      const merged = { files: [...byCid.values()], updatedAt: Date.now() };

      saveRoom({ id: roomId, manifest: merged });
      rooms.setManifest(roomId, merged);

      // Pin locally
      for (const f of added.files) {
        try {
          for await (const _ of helia.pin.add(f.cid)) {}
        } catch {}
      }

      // Upload blocks to mirror
      if (added.files.length > 0) {
        try {
          const blocks = [];
          const seen = new Set();

          for (const file of added.files) {
            // Use helia.blockstore to walk and collect all blocks
            const queue = [file.cid];

            while (queue.length > 0) {
              const cidStr = queue.shift();
              if (seen.has(cidStr)) continue;
              seen.add(cidStr);

              try {
                // Parse CID string to CID object
                const { CID } = await import('multiformats/cid');
                const cid = CID.parse(cidStr);
                const bytes = await helia.blockstore.get(cid);

                // Convert Uint8Array to base64 without stack overflow
                let binary = '';
                for (let i = 0; i < bytes.length; i++) {
                  binary += String.fromCharCode(bytes[i]);
                }
                blocks.push({
                  cid: cidStr,
                  bytes: btoa(binary)
                });

                // Try to parse as dag-pb to find links
                try {
                  const { decode } = await import('@ipld/dag-pb');
                  const block = decode(bytes);
                  if (block.Links) {
                    for (const link of block.Links) {
                      if (link.Hash) {
                        queue.push(link.Hash.toString());
                      }
                    }
                  }
                } catch {
                  // Not dag-pb or no links, that's ok
                }
              } catch (err) {
                console.warn(`[Mirror] Failed to get block ${cidStr}:`, err.message);
              }
            }
          }

          if (blocks.length > 0) {
            console.log(`[Mirror] Uploading ${blocks.length} blocks for ${added.files.length} files...`);
            await fetch(MIRROR_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ blocks })
            });
            console.log(`[Mirror] Upload complete: ${blocks.length} blocks`);
          }
        } catch (err) {
          console.warn('[Mirror] Upload failed:', err.message);
        }
      }

      await renderRoomsIfActive();
      toast("Files added to room");
    } catch (e) {
      console.error(e);
      toast("Failed to add files");
    }
  }

  // Helper to update rooms list UI
  function updateRoomsList() {
    const list = getRooms();
    renderRoomsList(list, async (r) => {
      goto("rooms", { room: r.id });
      await renderRoomsIfActive();
    });
  }

  async function renderRoomsIfActive() {
    if (currentView() !== "rooms") return;

    // Render rooms list
    updateRoomsList();

    // Active room
    const sp = new URLSearchParams(location.search);
    const rid = sp.get("room");
    if (!rid) {
      console.log('No room ID in URL');
      return;
    }

    console.log('Rendering room:', rid);

    roomUI.setActiveRoom(rid);
    let room = getRoom(rid);
    if (!room) {
      saveRoom({ id: rid, name: `Room ${rid.slice(0, 6)}`, createdAt: Date.now(), lastSeen: Date.now() });
      room = getRoom(rid);
      updateRoomsList();
    }

    // Update lastSeen for existing room
    saveRoom({ id: rid, lastSeen: Date.now() });

    // Join room (handles both host and joiner)
    await rooms.join(rid, {
      onManifestUpdate: async (manifest) => {
        console.log(`[Bootstrap] onManifestUpdate called for room ${rid.slice(0, 6)}: ${manifest.files.length} files`);
        const room = getRoom(rid);
        saveRoom({
          id: rid,
          name: room?.name || `Room ${rid.slice(0, 6)}`,
          manifest,
          lastSeen: Date.now()
        });
        updateRoomsList();
        if (roomUI.getActiveRoom() === rid) {
          console.log(`[Bootstrap] Re-rendering room UI`);
          await roomUI.render(rid);
        } else {
          console.log(`[Bootstrap] Not active room, skipping render`);
        }
      },
      onNewFiles: async (newCids) => {
        const room = getRoom(rid);
        const filesByCid = new Map(room?.manifest?.files?.map(f => [f.cid, f]) || []);

        for (let i = 0; i < newCids.length; i++) {
          const cid = newCids[i];
          const file = filesByCid.get(cid);
          const name = file?.name || cid.slice(0, 8);
          const size = file?.size ? formatBytes(file.size) : '';

          showFetchProgress(true, i + 1, newCids.length, `${name} ${size}`.trim());

          try {
            for await (const _ of helia.pin.add(cid)) { }
          } catch (err) {
            console.warn(`Failed to pin ${cid}:`, err.message);
          }
        }
        showFetchProgress(false);
      },
    });

    // Initial render (after join completes)
    await roomUI.render(rid);

    // Subscribe to chat and manifest observers
    await roomUI.subscribeChat(rid);
  }

  window.addEventListener("popstate", async () => {
    renderView();
    await renderRoomsIfActive();
  });
}
