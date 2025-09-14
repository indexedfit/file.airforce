import { formatDistanceToNow } from 'date-fns'

const $ = (id) => document.getElementById(id)
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v }
const setHidden = (id, hidden) => { const el = $(id); if (el) el.classList.toggle('hidden', hidden) }
export const toast = (msg) => {
  const t = $('toast'); if (!t) return
  t.textContent = msg; t.hidden = false
  setTimeout(() => t.hidden = true, 2000)
}

export function renderAddresses(addrs) {
  const ul = $('addr-list'); if (!ul) return
  const frag = document.createDocumentFragment()
  addrs.forEach(a => {
    const li = document.createElement('li')
    li.className = 'flex items-center gap-2'
    const btn = document.createElement('button')
    btn.className = 'px-1 text-xs border rounded'
    btn.textContent = 'Copy'
    btn.onclick = () => navigator.clipboard.writeText(a)
    const tt = document.createElement('span')
    tt.className = 'font-mono text-[11px] break-all'
    tt.textContent = a
    li.append(btn, tt)
    frag.appendChild(li)
  })
  ul.replaceChildren(frag)
}

export function renderPeerTypes(counts) {
  const ul = $('peer-types'); if (!ul) return
  ul.innerHTML = Object.entries(counts).map(([k, v]) => `<li>${k}: <b>${v}</b></li>`).join('')
}

export function renderPeerDetails(rows) {
  const ul = $('peer-details'); if (!ul) return
  const frag = document.createDocumentFragment()
  rows.forEach(r => {
    const li = document.createElement('li')
    li.innerHTML = `<div class="font-mono text-xs break-all">${r.id}</div>`
    const ad = document.createElement('ul')
    ad.className = 'pl-4 text-[11px] space-y-1'
    r.addrs.forEach(a => {
      const ii = document.createElement('li')
      ii.textContent = a
      ad.appendChild(ii)
    })
    li.appendChild(ad)
    frag.appendChild(li)
  })
  ul.replaceChildren(frag)
}

export function renderDrops(list, targetId) {
  const ul = $(targetId); if (!ul) return
  const frag = document.createDocumentFragment()
  list.forEach(d => {
    const li = document.createElement('li')
    li.className = 'py-2 flex items-center gap-3'
    li.innerHTML = `
      <div class="flex-1">
        <div class="font-medium">${d.name || '(unnamed drop)'} · <span class="text-xs text-gray-500">${formatDistanceToNow(d.createdAt, { addSuffix: true })}</span></div>
        <div class="text-xs text-gray-600">${d.files.length} file(s)</div>
      </div>
      <div class="flex gap-2">
        <button data-action="open" class="px-2 py-1 border rounded text-sm">Open</button>
        <button data-action="invite" class="px-2 py-1 border rounded text-sm">Invite</button>
      </div>
    `
    li.querySelector('[data-action="open"]').onclick = () => {
      const sp = new URLSearchParams(location.search); sp.set('view', 'rooms'); sp.set('room', d.roomId || ''); history.pushState(null, '', `?${sp}`)
      window.dispatchEvent(new Event('popstate'))
    }
    li.querySelector('[data-action="invite"]').onclick = () => document.getElementById('btn-invite').click()
    frag.appendChild(li)
  })
  ul.replaceChildren(frag)
}

export function setPeerId(id) { setText('peer-id', id) }
export function setConnCount(n) { setText('conn-count', String(n)) }
export function showCreateRoomPanel(show) { setHidden('create-room-panel', !show) }
export function showUploadProgress(show) { setHidden('upload-progress', !show) }
export function updateProgress(pct, label = '') {
  const bar = document.getElementById('progress-bar')
  const txt = document.getElementById('progress-text')
  if (bar) bar.style.width = `${pct}%`
  if (txt) txt.textContent = label
}

