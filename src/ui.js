import { formatDistanceToNow } from "date-fns";

const $ = (id) => document.getElementById(id);
const setText = (id, v) => {
  const el = $(id);
  if (el) el.textContent = v;
};
const setHidden = (id, hidden) => {
  const el = $(id);
  if (el) el.classList.toggle("hidden", hidden);
};

const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + " " + sizes[i];
};
export const toast = (msg) => {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 2000);
};

export function renderAddresses(addrs) {
  const ul = $("addr-list");
  if (!ul) return;
  const frag = document.createDocumentFragment();
  addrs.forEach((a) => {
    const li = document.createElement("li");
    li.className = "flex items-center gap-2";
    const btn = document.createElement("button");
    btn.className = "px-1 text-xs border rounded";
    btn.textContent = "Copy";
    btn.onclick = () => navigator.clipboard.writeText(a);
    const tt = document.createElement("span");
    tt.className = "font-mono text-[11px] break-all";
    tt.textContent = a;
    li.append(btn, tt);
    frag.appendChild(li);
  });
  ul.replaceChildren(frag);
}

export function renderPeerTypes(counts) {
  const ul = $("peer-types");
  if (!ul) return;
  ul.innerHTML = Object.entries(counts)
    .map(([k, v]) => `<li>${k}: <b>${v}</b></li>`)
    .join("");
}

export function renderPeerDetails(rows) {
  const ul = $("peer-details");
  if (!ul) return;
  const frag = document.createDocumentFragment();
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="font-mono text-xs break-all">${r.id}</div>`;
    const ad = document.createElement("ul");
    ad.className = "pl-4 text-[11px] space-y-1";
    r.addrs.forEach((a) => {
      const ii = document.createElement("li");
      ii.textContent = a;
      ad.appendChild(ii);
    });
    li.appendChild(ad);
    frag.appendChild(li);
  });
  ul.replaceChildren(frag);
}

export function renderDrops(list, targetId) {
  const ul = $(targetId);
  if (!ul) return;
  const frag = document.createDocumentFragment();
  list.forEach((d) => {
    const li = document.createElement("li");
    li.className = "py-2 flex items-center gap-3";
    li.innerHTML = `
      <div class="flex-1">
        <div class="font-medium">${
          d.name || "(unnamed drop)"
        } · <span class="text-xs text-gray-500">${formatDistanceToNow(
      d.createdAt,
      { addSuffix: true }
    )}</span></div>
        <div class="text-xs text-gray-600">${d.files.length} file(s)</div>
      </div>
      <div class="flex gap-2">
        <button data-action="open" class="px-2 py-1 border rounded text-sm">Open</button>
        <button data-action="invite" class="px-2 py-1 border rounded text-sm">Invite</button>
      </div>
    `;
    li.querySelector('[data-action="open"]').onclick = () => {
      const sp = new URLSearchParams(location.search);
      sp.set("view", "rooms");
      sp.set("room", d.roomId || "");
      const ex = globalThis.wcInviteExtras || {};
      if (ex.host) sp.set("host", ex.host);
      if (ex.tracker) sp.set("tracker", encodeURIComponent(ex.tracker));
      history.pushState(null, "", `?${sp}`);
      window.dispatchEvent(new Event("popstate"));
    };
    li.querySelector('[data-action="invite"]').onclick = () =>
      document.getElementById("btn-invite").click();
    frag.appendChild(li);
  });
  ul.replaceChildren(frag);
}

export function setPeerId(id) {
  setText("peer-id", id);
}
export function setConnCount(n) {
  setText("conn-count", String(n));
}
export function showCreateRoomPanel(show) {
  setHidden("create-room-panel", !show);
}
export function showUploadProgress(show) {
  setHidden("upload-progress", !show);
}
export function updateProgress(pct, label = "") {
  const bar = document.getElementById("progress-bar");
  const txt = document.getElementById("progress-text");
  if (bar) bar.style.width = `${pct}%`;
  if (txt) txt.textContent = label;
}

// -------- Rooms & Chat rendering --------
function renderFilesList(files, thumbnails) {
  return `<ul id="room-files" class="space-y-1 max-h-96 overflow-y-auto">${files
    .map((f, idx) => {
      const thumbUrl = thumbnails[f.cid];
      const thumbHtml = thumbUrl
        ? `<img src="${thumbUrl}" class="w-10 h-10 object-cover rounded border flex-shrink-0" />`
        : `<div class="w-10 h-10 flex items-center justify-center bg-gray-100 rounded border text-lg flex-shrink-0">📄</div>`;
      return `
        <li class="flex items-center gap-2 p-2 hover:bg-gray-50 rounded cursor-pointer min-h-[3.5rem]" data-idx="${idx}" data-cid="${f.cid}" tabindex="0">
          ${thumbHtml}
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium truncate">${f.name}</div>
            <div class="text-xs text-gray-500">${formatBytes(f.size)}</div>
          </div>
          <div class="flex gap-1 flex-shrink-0">
            <button data-action="open-file" data-cid="${f.cid}" data-name="${f.name}" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">Open</button>
            <button data-action="download-file" data-cid="${f.cid}" data-name="${f.name}" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">↓</button>
          </div>
        </li>`;
    })
    .join("")}</ul>`;
}

function renderFilesGrid(files, thumbnails) {
  return `<div id="room-files" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-96 overflow-y-auto">${files
    .map((f, idx) => {
      const thumbUrl = thumbnails[f.cid];
      const thumbHtml = thumbUrl
        ? `<img src="${thumbUrl}" class="w-full h-32 object-cover rounded-t" />`
        : `<div class="w-full h-32 flex items-center justify-center bg-gray-100 rounded-t text-4xl">📄</div>`;
      return `
        <div class="border rounded overflow-hidden hover:shadow-lg transition-shadow cursor-pointer" data-idx="${idx}" data-cid="${f.cid}" tabindex="0">
          ${thumbHtml}
          <div class="p-2 bg-white">
            <div class="text-xs font-medium truncate mb-1" title="${f.name}">${f.name}</div>
            <div class="text-xs text-gray-500">${formatBytes(f.size)}</div>
            <div class="flex gap-1 mt-2">
              <button data-action="open-file" data-cid="${f.cid}" data-name="${f.name}" class="flex-1 px-2 py-1 border rounded text-xs hover:bg-gray-100">Open</button>
              <button data-action="download-file" data-cid="${f.cid}" data-name="${f.name}" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">↓</button>
            </div>
          </div>
        </div>`;
    })
    .join("")}</div>`;
}

export function renderRoomsList(rooms, onOpen, targetId = 'rooms-list') {
  const ul = $(targetId);
  if (!ul) return;
  const frag = document.createDocumentFragment();
  rooms.forEach((r) => {
    const li = document.createElement("li");
    li.className = "py-2 flex items-center gap-3";
    const filesCount = r.manifest?.files?.length || 0;
    li.innerHTML = `
      <div class="flex-1">
        <div class="font-medium">${
          r.name || "(room)"
        } · <span class="text-xs text-gray-500">${filesCount} file(s)</span></div>
        <div class="text-xs text-gray-600">Last seen: ${
          r.lastSeen
            ? formatDistanceToNow(r.lastSeen, { addSuffix: true })
            : "—"
        }</div>
      </div>
      <div class="flex gap-2">
        <button data-action="open" class="px-2 py-1 border rounded text-sm">Open</button>
      </div>
    `;
    li.querySelector('[data-action="open"]').onclick = () => onOpen(r);
    frag.appendChild(li);
  });
  ul.replaceChildren(frag);
}

export function renderRoomDetails(room, opts = {}) {
  const root = $("rooms-info");
  if (!root) return;
  const files = room?.manifest?.files || [];
  const thumbnails = opts.thumbnails || {}; // cid -> data URL
  const viewMode = opts.viewMode || 'list'; // 'list' or 'grid'

  root.innerHTML = `
    <div class="mb-3">
      <div class="flex items-center gap-2 flex-wrap">
        <div class="font-semibold">${
          room?.name || "(room)"
        } <span class="text-xs text-gray-500">${room?.id || ""}</span></div>
        <div class="ml-auto flex items-center gap-2">
          <button id="btn-view-list" class="px-2 py-1 border rounded text-xs ${viewMode === 'list' ? 'bg-gray-200' : ''}">List</button>
          <button id="btn-view-grid" class="px-2 py-1 border rounded text-xs ${viewMode === 'grid' ? 'bg-gray-200' : ''}">Grid</button>
          <button id="btn-share-room" class="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700">Share</button>
        </div>
      </div>
    </div>
    <div class="grid md:grid-cols-2 gap-4">
      <div>
        <div class="font-medium mb-1">Files in room</div>
        ${
          files.length
            ? ""
            : '<div class="text-sm text-gray-600">No files yet.</div>'
        }
        ${viewMode === 'list' ? renderFilesList(files, thumbnails) : renderFilesGrid(files, thumbnails)}

        <div class="mt-4 p-3 bg-gray-50 border rounded">
          <div class="font-medium mb-1">Add files to this room</div>
          <div id="room-dropzone" class="border-2 border-dashed rounded p-4 text-center text-xs text-gray-600 bg-white hover:bg-gray-50">
            <input id="room-file-input" type="file" multiple class="hidden"/>
            <p>Drag & drop, or <button type="button" id="btn-room-browse" class="underline">browse</button></p>
          </div>
        </div>
      </div>
      <div>
        <div class="font-medium mb-1">Chat</div>
        <div id="chat-box" class="border rounded h-48 overflow-auto p-2 bg-white"></div>
        <div class="mt-2 flex items-center gap-2">
          <input id="chat-input" class="flex-1 border rounded px-2 py-1" placeholder="Type a message"/>
          <button id="btn-chat-send" class="px-2 py-1 border rounded">Send</button>
        </div>
      </div>
    </div>
  `;
}

export function renderChatMessages(messages, selfId = "") {
  const box = $("chat-box");
  if (!box) return;
  const frag = document.createDocumentFragment();
  messages.forEach((m) => {
    const div = document.createElement("div");
    const isSelf = selfId && m.from === selfId;
    div.className = `text-sm mb-1 ${
      isSelf ? "text-blue-700" : "text-gray-800"
    }`;
    const fromShort = (m.from || "anon").slice(0, 16);
    const time = m.ts ? new Date(m.ts).toLocaleTimeString() : "";
    div.textContent = `[${time}] ${fromShort}: ${m.text}`;
    div.title = m.from || "anon"; // Full ID on hover
    frag.appendChild(div);
  });
  box.replaceChildren(frag);
  box.scrollTop = box.scrollHeight;
}
