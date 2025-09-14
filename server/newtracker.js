// relay-mirror.js
// @ts-check
import { createLibp2p } from 'libp2p'
import { autoNAT } from '@libp2p/autonat'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { bootstrap } from '@libp2p/bootstrap'

// DHT is optional & toggleable
let kadDHT
if (process.env.DHT_ENABLED === '1') {
  ({ kadDHT } = await import('@libp2p/kad-dht'))
}

// Optional browser-first transports
const enableWebRTC = process.env.ENABLE_WEBRTC === '1'
const enableWebTransport = process.env.ENABLE_WEBTRANSPORT === '1'
let webrtc, webTransport
if (enableWebRTC) ({ webRTC: webrtc } = await import('@libp2p/webrtc'))
if (enableWebTransport) ({ webTransport } = await import('@libp2p/webtransport'))

// Delegated HTTP Routing client (read-only routing over HTTP)
import { createDelegatedRoutingV1HttpApiClient } from '@helia/delegated-routing-v1-http-api-client'

import { createHelia } from 'helia'
import { FsBlockstore } from 'blockstore-fs'
import { LevelDatastore } from 'datastore-level'
import { CID } from 'multiformats/cid'
import { toString as u8ToString } from 'uint8arrays/to-string'
import logUpdate from 'log-update'

import process from 'node:process'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'

import { PUBSUB_PEER_DISCOVERY, ROOM_TOPIC } from './constants.js'

// ---------- config via env (with sane defaults) ----------
// Polyfill CustomEvent for Node < 19
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) { super(type); this.detail = params.detail }
  }
}
// Polyfill Promise.withResolvers for Node < 20
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    /** @type {(value: any) => void} */ let resolve
    /** @type {(reason?: any) => void} */ let reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    // @ts-ignore - add missing method at runtime
    return { promise, resolve, reject }
  }
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const BLOCKS_DIR = path.join(DATA_DIR, 'blocks')
const DS_DIR = path.join(DATA_DIR, 'datastore')

const CONTENT_TOPIC = process.env.CONTENT_TOPIC || 'app.content.v1' // messages carry CIDs
const DISCOVERY_TOPIC = process.env.DISCOVERY_TOPIC || 'app.rooms.announce' // optional
const ROOM_IDS = (process.env.ROOM_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

const LISTEN_WS = process.env.LISTEN_WS || '/ip4/0.0.0.0/tcp/9001/ws'
const LISTEN_TCP = process.env.LISTEN_TCP || '/ip4/0.0.0.0/tcp/9002'
const LISTEN_WT = process.env.LISTEN_WT || '' // e.g. '/ip4/0.0.0.0/udp/9443/quic-v1/webtransport'
const LISTEN_WEBRTC = process.env.LISTEN_WEBRTC || '' // e.g. '/ip4/0.0.0.0/udp/9091/webrtc-direct' (see docs)

const BOOTSTRAP = (process.env.BOOTSTRAP || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const ROUTER_URL_DEFAULT = 'https://router.ipfs.io'
let ROUTER_URL = process.env.ROUTER_URL || ROUTER_URL_DEFAULT
let GATEWAYS = (process.env.GATEWAYS || '').split(',').map(s => s.trim()).filter(Boolean)

// optional dynamic network config JSON
if (process.env.NET_CFG_URL) {
  try {
    const res = await fetch(process.env.NET_CFG_URL)
    if (res.ok) {
      const cfg = await res.json()
      if (Array.isArray(cfg.bootstrap)) BOOTSTRAP.push(...cfg.bootstrap)
      if (Array.isArray(cfg.gateways)) GATEWAYS = cfg.gateways
      if (typeof cfg.routerUrl === 'string') ROUTER_URL = cfg.routerUrl
    }
  } catch (e) {
    console.warn('[net-cfg] failed to fetch NET_CFG_URL:', e?.message)
  }
}

const PIN_CONCURRENCY = Math.max(1, Number(process.env.PIN_CONCURRENCY || 2))
const GC_INTERVAL_SECONDS = Number(process.env.GC_INTERVAL_SECONDS || 0)

function extractCids(bytes) {
  const out = new Set()
  try {
    const obj = JSON.parse(u8ToString(bytes))
    const arr = Array.isArray(obj) ? obj : (obj?.cids ?? [obj?.cid]).filter(Boolean)
    for (const v of arr) {
      try { out.add(CID.parse(String(v)).toString()) } catch { }
    }
  } catch {
    const text = u8ToString(bytes)
    const re = /\b(bafy[0-9a-z]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44,})\b/g
    for (const m of text.matchAll(re)) {
      try { out.add(CID.parse(m[1]).toString()) } catch { }
    }
    const reUrl = /\bipfs:\/\/([A-Za-z0-9]+)\b/g
    for (const m of text.matchAll(reUrl)) {
      try { out.add(CID.parse(m[1]).toString()) } catch { }
    }
  }
  return [...out].map(s => CID.parse(s))
}

async function consume(asyncIt) { for await (const _ of asyncIt) { } }

async function main() {
  // ---------- libp2p ----------
  /** @type {import('libp2p').Libp2pOptions<any>} */
  const lpOpts = {
    addresses: {
      listen: [
        LISTEN_WS,
        LISTEN_TCP,
        ...(LISTEN_WT ? [LISTEN_WT] : []),
        ...(LISTEN_WEBRTC ? [LISTEN_WEBRTC] : [])
      ].filter(Boolean)
    },
    transports: [
      webSockets(),
      tcp(),
      ...(enableWebTransport ? [webTransport()] : []),
      ...(enableWebRTC ? [webrtc()] : [])
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [
      ...(BOOTSTRAP.length ? [bootstrap({ list: BOOTSTRAP })] : [])
    ],
    services: {
      identify: identify(),
      autoNat: autoNAT(),
      relay: circuitRelayServer(),
      pubsub: gossipsub(),
      ...(process.env.DHT_ENABLED === '1'
        ? { dht: kadDHT({ clientMode: process.env.DHT_CLIENT_MODE !== '0' }) }
        : {})
    }
  }

  // add delegated routing as a libp2p service when NO DHT
  if (process.env.DHT_ENABLED !== '1') {
    lpOpts.services = lpOpts.services || {}
    // libp2p expects a service factory function; return the HTTP client instance
    lpOpts.services.delegatedRouting = () => createDelegatedRoutingV1HttpApiClient(ROUTER_URL)
  }

  const libp2p = await createLibp2p(lpOpts)

  // ---------- helia (persistent) ----------
  const blockstore = new FsBlockstore(BLOCKS_DIR)
  const datastore = new LevelDatastore(DS_DIR)

  const helia = await createHelia({
    libp2p,
    blockstore,
    datastore
    // Helia will use libp2p routing (DHT or delegated) under the hood
  })

  // ---------- mirror state ----------
  const seen = new Set()   // seen CIDs
  const pinned = new Set() // pinned CIDs
  const pubs = new Map()   // peerId -> {count,lastCid}
  let latestConn = null
  let pinInFlight = 0

  function render() {
    const addrs = libp2p.getMultiaddrs().map(a => a.toString())
    const top = [...pubs.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5)
    return [
      `PeerID:        ${libp2p.peerId.toString()}`,
      `Multiaddrs:`,
      ...addrs.map(a => `  • ${a}`),
      ``,
      `Mode:          ${process.env.DHT_ENABLED === '1' ? 'PUBLIC (DHT client mode)' : 'PRIVATE (HTTP delegated routing)'}`,
      `Router:        ${process.env.DHT_ENABLED === '1' ? '(kad-dht)' : ROUTER_URL}`,
      `Gateways:      ${GATEWAYS.length ? GATEWAYS.join(', ') : '(default trustless set)'}`,
      ``,
      `Connections:   ${libp2p.getConnections().length}`,
      latestConn ? `Newest conn:   ${latestConn.remoteAddr?.toString?.() || ''} (${latestConn.remotePeer?.toString?.() || ''})` : `Newest conn:   (none)`,
      ``,
      `Content topic: ${CONTENT_TOPIC}`,
      `Seen:          ${seen.size} | Pinned: ${pinned.size} | In-flight: ${pinInFlight}`,
      `Top publishers:`,
      ...top.map(([p, info]) => `  • ${p} (${info.count}) last=${info.lastCid}`),
      ``
    ].join('\n')
  }

  logUpdate(render())
  const uiTimer = setInterval(() => logUpdate(render()), 1000)

  libp2p.addEventListener('connection:open', (evt) => { latestConn = evt.detail })

  // subscribe & mirror
  libp2p.services.pubsub.subscribe(CONTENT_TOPIC)
  libp2p.services.pubsub.subscribe(PUBSUB_PEER_DISCOVERY)
  if (DISCOVERY_TOPIC) libp2p.services.pubsub.subscribe(DISCOVERY_TOPIC)
  for (const rid of ROOM_IDS) {
    libp2p.services.pubsub.subscribe(ROOM_TOPIC(rid))
  }

  libp2p.services.pubsub.addEventListener('message', async (evt) => {
    const { topic, data, from } = evt.detail

    // Flow A: generic content topic – extract any CIDs and pin
    let cids = []
    if (topic === CONTENT_TOPIC) {
      cids = extractCids(data ?? new Uint8Array())
    }

    // Flow B: room REQUEST messages – pin requested fileCids
    // make this better asap.
    if (topic.startsWith('wc/')) {
      try {
        const msg = JSON.parse(u8ToString(data || new Uint8Array()))
        if (msg && msg.type === 'REQUEST' && Array.isArray(msg.fileCids)) {
          cids = msg.fileCids.map((s) => CID.parse(String(s)))
        }
      } catch { }
    }

    if (cids.length === 0) return

    const key = from?.toString?.() || 'unknown'
    const cur = pubs.get(key) ?? { count: 0, lastCid: '' }
    cur.count += cids.length
    cur.lastCid = cids[cids.length - 1].toString()
    pubs.set(key, cur)

    for (const cid of cids) {
      const s = cid.toString()
      if (pinned.has(s) || seen.has(s)) continue
      seen.add(s)

        ; (async () => {
          while (pinInFlight >= PIN_CONCURRENCY) await sleep(50)
          pinInFlight++
          try {
            // Helia's pin API is helia.pin.add (yields progress)
            await consume(helia.pin.add(cid, { recursive: true }))
            pinned.add(s)

            // Announce only if DHT is enabled
            if (process.env.DHT_ENABLED === '1') {
              await libp2p.contentRouting.provide(cid).catch(() => { })
            }
          } catch (e) {
            console.warn('[mirror] pin failed', s, e?.message)
          } finally {
            pinInFlight--
          }
        })().catch(() => { })
    }
  })

  console.log('PeerID: ', libp2p.peerId.toString())
  console.log('Multiaddrs: ', libp2p.getMultiaddrs().map(a => a.toString()))

  // periodic GC (optional; pins protect)
  if (GC_INTERVAL_SECONDS > 0) {
    ; (async () => {
      while (true) {
        await sleep(GC_INTERVAL_SECONDS * 1000)
        try { await helia.gc() } catch { }
      }
    })().catch(() => { })
  }

  const shutdown = async () => {
    clearInterval(uiTimer)
    logUpdate.clear()
    await helia.stop().catch(() => { })
    await libp2p.stop().catch(() => { })
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
