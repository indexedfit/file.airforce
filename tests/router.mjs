// Router DOM toggling smoke test using jsdom
import { JSDOM } from 'jsdom'

// Build a minimal DOM with our view sections
const dom = new JSDOM(`<!doctype html><html><body>
  <section id="view-home"></section>
  <section id="view-drops" hidden></section>
  <section id="view-rooms" hidden></section>
  <section id="view-peers" hidden></section>
</body></html>`, { url: 'http://localhost/?view=rooms' })

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.history = dom.window.history
globalThis.location = dom.window.location

const { renderView, goto, currentView } = await import('../src/router.js')

// initial: URL says rooms
renderView()
const roomsEl = document.getElementById('view-rooms')
const homeEl = document.getElementById('view-home')
if (!roomsEl || !homeEl) throw new Error('views missing')
if (roomsEl.hidden !== false) throw new Error('rooms should be visible')
if (homeEl.hidden !== true) throw new Error('home should be hidden')

// navigate to peers
goto('peers')
if (currentView() !== 'peers') throw new Error('currentView should be peers')
const peersEl = document.getElementById('view-peers')
if (peersEl.hidden !== false) throw new Error('peers should be visible after goto')

console.log('router:ok')

