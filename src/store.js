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
  if (idx >= 0) all[idx] = { ...all[idx], ...room, lastSeen: Date.now() }
  else all.unshift({ ...room, lastSeen: Date.now() })
  write(LS_ROOMS, all)
}
export function getRoom(roomId) { return getRooms().find(r => r.id === roomId) }

export function getPeers() { return read(LS_PEERS, {}) }
export function setPeerNickname(peerId, nickname) {
  const peers = getPeers()
  peers[peerId] = { ...(peers[peerId] || {}), nickname }
  write(LS_PEERS, peers)
}

// Chat is now handled by Y.js CRDTs - no localStorage needed
