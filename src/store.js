import { LS_DROPS, LS_ROOMS, LS_PEERS } from './constants.js'

const read = (k, d) => {
  try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d }
  catch { return d }
}
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v))

export function getDrops() { return read(LS_DROPS, []) }
export function saveDrop(drop) {
  const all = getDrops()
  const idx = all.findIndex(d => d.id === drop.id)
  if (idx >= 0) all[idx] = drop; else all.unshift(drop)
  write(LS_DROPS, all)
}

export function getRooms() { return read(LS_ROOMS, []) }
export function saveRoom(room) {
  const all = getRooms()
  const idx = all.findIndex(r => r.id === room.id)
  if (idx >= 0) all[idx] = { ...all[idx], ...room }
  else all.unshift({ ...room, lastSeen: Date.now() })
  write(LS_ROOMS, all)
}
export function getRoom(roomId) { return getRooms().find(r => r.id === roomId) }
export function updateRoomLastSeen(roomId) {
  const all = getRooms()
  const idx = all.findIndex(r => r.id === roomId)
  if (idx >= 0) { all[idx].lastSeen = Date.now(); write(LS_ROOMS, all) }
}

export function getPeers() { return read(LS_PEERS, {}) }
export function setPeerNickname(peerId, nickname) {
  const peers = getPeers()
  peers[peerId] = { ...(peers[peerId] || {}), nickname }
  write(LS_PEERS, peers)
}

// ---- chat (per room) ----
const CHAT_KEY = (roomId) => `wc:chat:${roomId}`
export function getChat(roomId) { return read(CHAT_KEY(roomId), []) }
export function addChatMessage(roomId, msg, max = 200) {
  const msgs = getChat(roomId)
  const id = msg?.msgId
  if (id) {
    const exists = msgs.find(m => m?.msgId === id)
    if (!exists) msgs.push(msg)
  } else {
    msgs.push(msg)
  }
  if (msgs.length > max) msgs.splice(0, msgs.length - max)
  write(CHAT_KEY(roomId), msgs)
  return msgs
}
