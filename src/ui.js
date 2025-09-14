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
export function renderRoomsList(rooms, onOpen) {
  const ul = $("rooms-list");
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
  root.innerHTML = `
    <div class="mb-3">
      <div class="font-semibold">${
        room?.name || "(room)"
      } <span class="text-xs text-gray-500">${room?.id || ""}</span></div>
    </div>
    <div class="grid md:grid-cols-2 gap-4">
      <div>
        <div class="font-medium mb-1">Files in room</div>
        ${
          files.length
            ? ""
            : '<div class="text-sm text-gray-600">No files yet.</div>'
        }
        <ul id="room-files" class="space-y-1">${files
          .map(
            (f) => `
          <li class=\"flex items-center gap-2\">\n            <input type=\"checkbox\" data-cid=\"${
            f.cid
          }\" checked/>\n            <span>${
              f.name
            }</span>\n            <span class=\"text-xs text-gray-500\">${
              f.size ?? ""
            } ${f.size ? "bytes" : ""}</span>\n          </li>`
          )
          .join("")}</ul>
        <button id="btn-request-files" class="mt-2 px-2 py-1 border rounded">Request & Mirror</button>
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
    const fromShort = (m.from || "anon").slice(0, 8);
    const time = m.ts ? new Date(m.ts).toLocaleTimeString() : "";
    div.textContent = `[${time}] ${fromShort}: ${m.text}`;
    frag.appendChild(div);
  });
  box.replaceChildren(frag);
  box.scrollTop = box.scrollHeight;
}
