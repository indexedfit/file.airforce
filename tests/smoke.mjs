// Simple Node-based smoke test for src/store.js
// Polyfill localStorage and assert store behaviors.

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, v) },
  removeItem(k) { this._m.delete(k) },
  clear() { this._m.clear() }
}

import { saveDrop, getDrops, saveRoom, getRoom, updateRoomLastSeen } from '../src/store.js'

function assert(cond, msg) { if (!cond) throw new Error(msg) }

// Drops
const drop = { id: 'd1', name: 'first', createdAt: Date.now(), files: [{ name: 'a.txt', size: 1, cid: 'cid-a' }] }
saveDrop(drop)
let drops = getDrops()
assert(drops.length === 1, 'should have one drop')
assert(drops[0].id === 'd1', 'drop id should match')

// Update same drop
saveDrop({ ...drop, name: 'first-updated' })
drops = getDrops()
assert(drops[0].name === 'first-updated', 'drop should be updated in place')

// Rooms
const room = { id: 'r1', name: 'room-1', createdAt: Date.now(), manifest: { files: [] } }
saveRoom(room)
let r = getRoom('r1')
assert(r && r.id === 'r1', 'room should be retrievable')
const prev = r.lastSeen
updateRoomLastSeen('r1')
r = getRoom('r1')
assert(r.lastSeen >= prev, 'lastSeen should be updated')

console.log('smoke:ok')

