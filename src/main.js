import QRCode from "qrcode";
import { startHelia } from "./heliaNode.js";
import { createRoomManager } from "./room.js";
import { bindNavLinks, renderView, goto, currentView } from "./router.js";
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
  renderRoomDetails,
  renderChatMessages,
} from "./ui.js";
import {
  saveDrop,
  getDrops,
  saveRoom,
  getRoom,
  getRooms,
  getChat,
  addChatMessage,
} from "./store.js";
import { TRACKERS } from "./constants.js";
import { listAddresses, countPeerTypes, peerDetails } from "./peers.js";

const $ = (id) => document.getElementById(id);

let helia, fs, libp2p, rooms;
let activeRoomId = null;
let chatUnsub = null;

function urlFlag(name) {
  return new URLSearchParams(location.search).has(name);
}

async function startHeliaMaybeFake() {
  if (urlFlag("fake")) {
    const fakePeerId =
      "fake-" + (crypto.randomUUID?.() || Math.random().toString(36).slice(2));
    const fake = {
      libp2p: {
        peerId: { toString: () => fakePeerId },
        getConnections: () => [],
        getMultiaddrs: () => [],
      },
    };
    const fakeFs = {
      async addBytes(bytes) {
        // pseudo CID: bafk + base36 length + random
        return {
          toString: () =>
            `bafk${bytes.length.toString(36)}${Math.random()
              .toString(36)
              .slice(2, 8)}`,
        };
      },
    };
    // Pin API shim
    fake.pin = { add: async function* () {} };
    return { helia: fake, fs: fakeFs, libp2p: fake.libp2p };
  }
  return startHelia();
}

async function addFilesAndCreateManifest(files) {
  const manifest = { files: [] };
  let done = 0;
  showUploadProgress(true);
  try {
    for (const f of files) {
      const data = new Uint8Array(await f.arrayBuffer());
      const cid = await fs.addBytes(data);
      manifest.files.push({ name: f.name, size: f.size, cid: cid.toString() });
      done++;
      updateProgress(
        Math.round((done / files.length) * 100),
        `${done}/${files.length}`
      );
    }
    return manifest;
  } finally {
    showUploadProgress(false);
  }
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
  u.searchParams.set("host", helia.libp2p.peerId.toString());
  if (TRACKERS?.length)
    u.searchParams.set("tracker", encodeURIComponent(TRACKERS[0]));
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

async function startUI() {
  ({ helia, fs, libp2p } = await startHeliaMaybeFake());
  rooms = createRoomManager(helia, fs);

  // expose extras so UI helpers (no direct libp2p import) can add them to URLs
  // todo doublecheck.
  globalThis.wcInviteExtras = {
    host: libp2p.peerId.toString(),
    tracker: TRACKERS?.[0] || "",
  };

  setPeerId(libp2p.peerId.toString());
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

  // Global error handlers to avoid silent failures
  window.addEventListener("unhandledrejection", (e) => {
    console.error("Unhandled rejection", e.reason);
    toast(e?.reason?.message || "Unexpected error");
  });
  window.addEventListener("error", (e) => {
    console.error("Error", e.error || e.message);
    toast(e?.error?.message || e.message || "Error");
  });

  const dropzone = $("dropzone");
  const fileInput = $("file-input");
  const browse = $("btn-browse");
  const createRoomBtn = $("btn-create-room");
  const inviteBtn = $("btn-invite");

  // Keep selected files in state; don't assign to input.files (read-only in many browsers)
  let selectedFiles = [];

  browse.onclick = () => fileInput.click();
  dropzone.ondragover = (e) => {
    e.preventDefault();
    dropzone.classList.add("bg-white");
  };
  dropzone.ondragleave = () => dropzone.classList.remove("bg-white");
  async function handleSelectedFiles(files) {
    selectedFiles = Array.from(files || []);
    showCreateRoomPanel(selectedFiles.length > 0);
    try {
      const note = document.createElement("div");
      note.className = "mt-2 text-xs text-gray-600";
      note.id = "selected-files-note";
      const names = selectedFiles
        .slice(0, 5)
        .map((f) => f.name)
        .join(", ");
      note.textContent = selectedFiles.length
        ? `Selected ${selectedFiles.length} file(s): ${names}${
            selectedFiles.length > 5 ? "…" : ""
          }`
        : "";
      const prev = document.getElementById("selected-files-note");
      if (prev?.parentElement) prev.parentElement.removeChild(prev);
      dropzone.appendChild(note);
    } catch {}

    // Auto-create room+drop unless we’re in a join context
    if (!isJoinContext() && selectedFiles.length) {
      await autoCreateDropAndRoom();
    }
  }

  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove("bg-white");
    handleSelectedFiles(e.dataTransfer.files);
  };
  fileInput.onchange = () => handleSelectedFiles(fileInput.files);

  let lastManifest = null;
  let lastRoom = null;
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
      const manifest = await addFilesAndCreateManifest(selectedFiles);
      lastManifest = manifest;
      const defaultName = $("drop-name")?.value?.trim() || randomSlug();

      const drop = {
        id: randId(),
        name: defaultName,
        createdAt: Date.now(),
        files: manifest.files,
      };
      for (const f of manifest.files) {
        try {
          for await (const _ of helia.pin.add(f.cid)) {
          }
        } catch {}
      }
      const room = {
        id: randId(),
        name: $("room-name")?.value?.trim() || defaultName,
        manifest,
        createdAt: Date.now(),
      };

      saveDrop({ ...drop, roomId: room.id });
      saveRoom(room);
      rooms.attachHost(room);

      // Proactively announce files so joiners see them immediately
      rooms.sendManifest(room.id, manifest).catch(() => {});

      lastRoom = room;
      renderDrops(getDrops().slice(0, 5), "drops-list");
      // Navigate with host/tracker in URL; keep QR/share ready
      const extras = { room: room.id, host: libp2p.peerId.toString() };
      if (TRACKERS?.length) extras.tracker = encodeURIComponent(TRACKERS[0]);
      goto("rooms", extras);
      globalThis.wcInviteExtras = {
        host: libp2p.peerId.toString(),
        tracker: TRACKERS?.[0] || "",
      };

      activeRoomId = room.id;
      renderRoomsIfActive();
      showInvite(buildInviteURL(room.id));
      toast("Room created and files pinned locally");
    } catch (err) {
      console.error("autoCreate failed", err);
      toast("Failed to create drop/room");
    } finally {
      creationInFlight = false;
    }
  }

  createRoomBtn.onclick = async () => {
    if (!selectedFiles.length) {
      toast("Select files first");
      return;
    }
    await autoCreateDropAndRoom();
  };

  inviteBtn.onclick = async () => {
    if (!lastRoom) {
      toast("Create a drop/room first");
      return;
    }
    const link = buildInviteURL(lastRoom.id);
    showInvite(link);
  };

  renderDrops(getDrops().slice(0, 5), "drops-list");
  renderDrops(getDrops(), "drops-list-full");

  $("btn-join-room").onclick = async () => {
    const input = $("join-room-id").value.trim();
    if (!input) return;
    let roomId = input;
    try {
      const u = new URL(input);
      roomId = u.searchParams.get("room") || input;
    } catch {}
    const existing = getRoom(roomId);
    if (!existing)
      saveRoom({
        id: roomId,
        name: `Room ${roomId.slice(0, 6)}`,
        createdAt: Date.now(),
      });
    rooms.attachJoin(roomId, (manifest) => {
      saveRoom({ id: roomId, manifest });
      renderRoomsIfActive();
    });
    goto("rooms", { room: roomId });
    activeRoomId = roomId;
    renderRoomsIfActive();
    toast(`Joined room ${roomId}`);
  };

  // ---------- Rooms view controller ----------
  function bindRoomButtons(roomId) {
    const roomsInfo = $("rooms-info");
    const btnReq = document.getElementById("btn-request-files");
    if (btnReq)
      btnReq.onclick = async () => {
        const cids = [
          ...roomsInfo.querySelectorAll('input[type="checkbox"]:checked'),
        ].map((i) => i.dataset.cid);
        if (!cids.length) return toast("Select at least one file");
        rooms.requestFiles(roomId, cids).catch(() => {});
        for (const cid of cids) {
          try {
            for await (const _ of helia.pin.add(cid)) {
            }
          } catch {}
        }
        toast("Requested and mirrored selected files");
      };

    const input = document.getElementById("chat-input");
    const send = document.getElementById("btn-chat-send");
    if (send && input) {
      const sendNow = async () => {
        const text = input.value.trim();
        if (!text) return;
        await rooms.sendChat(roomId, text);
        addChatMessage(roomId, {
          type: "CHAT",
          roomId,
          text,
          from: libp2p.peerId.toString(),
          ts: Date.now(),
        });
        input.value = "";
        renderChatMessages(getChat(roomId), libp2p.peerId.toString());
      };
      send.onclick = sendNow;
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          sendNow();
        }
      };
    }
  }

  function subscribeChat(roomId) {
    if (chatUnsub) {
      chatUnsub();
      chatUnsub = null;
    }
    chatUnsub = rooms.subscribe(roomId, (msg) => {
      if (msg?.type !== "CHAT") return;
      addChatMessage(roomId, msg);
      if (roomId === activeRoomId && currentView() === "rooms") {
        renderChatMessages(getChat(roomId), libp2p.peerId.toString());
      }
    });
  }

  function renderRoomsIfActive() {
    if (currentView() !== "rooms") return;
    // rooms list
    const list = getRooms();
    renderRoomsList(list, (r) => {
      goto("rooms", { room: r.id });
      activeRoomId = r.id;
      renderRoomsIfActive();
    });
    // active room
    const sp = new URLSearchParams(location.search);
    const rid = sp.get("room");
    if (!rid) return;
    activeRoomId = rid;
    const room = getRoom(rid);
    if (room?.manifest) {
      renderRoomDetails(room);
      renderChatMessages(getChat(rid), libp2p.peerId.toString());
      bindRoomButtons(rid);
      subscribeChat(rid);
    } else {
      // request manifest by sending HELLO if not yet known
      rooms.attachJoin(rid, (manifest) => {
        saveRoom({ id: rid, manifest });
        renderRoomsIfActive();
      });
      renderRoomDetails({
        id: rid,
        name: room?.name || `Room ${rid.slice(0, 6)}`,
        manifest: { files: [] },
      });
      bindRoomButtons(rid);
      subscribeChat(rid);
    }
  }

  window.addEventListener("popstate", () => {
    renderView();
    renderRoomsIfActive();
  });
}

startUI().catch((e) => {
  console.error(e);
  toast("Failed to start Helia/libp2p");
});
