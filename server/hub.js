// @ts-check
import { createLibp2p } from 'libp2p'
import { createHelia } from 'helia'
import { autoNAT } from '@libp2p/autonat'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { FsBlockstore } from 'blockstore-fs'
import { LevelDatastore } from 'datastore-level'
import { CID } from 'multiformats/cid'
import * as Y from 'yjs'
import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { PUBSUB_PEER_DISCOVERY, ROOM_TOPIC } from '../src/lib/constants.js'

// ===== CLI FLAGS =====
const args = process.argv.slice(2)
const flags = {
  relay: args.includes('--relay') || args.includes('--relay-only'),
  mirror: args.includes('--mirror') || args.includes('--mirror-only'),
  sync: args.includes('--sync') || args.includes('--sync-only'),
}

const anyOnly = args.some(a => a.endsWith('-only'))
if (!anyOnly) {
  flags.relay = flags.mirror = flags.sync = true
}

console.log('Hub modes:', flags)

// ===== ENCODING =====
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

// ===== Y.JS ROOMS =====
const rooms = new Map()
const roomLocks = new Map() // Prevent race conditions
let YDOCS_DIR = './data/ydocs' // Will be updated in main()

async function ensureYDocsDir() {
  if (!existsSync(YDOCS_DIR)) {
    await mkdir(YDOCS_DIR, { recursive: true })
  }
}

async function loadYDocState(roomId) {
  const filePath = `${YDOCS_DIR}/${roomId}.yjs`
  try {
    if (existsSync(filePath)) {
      const data = await readFile(filePath)
      console.log(`[${roomId.slice(0, 6)}] Loaded ${data.length} bytes`)
      return new Uint8Array(data)
    }
  } catch (err) {
    console.warn(`[${roomId.slice(0, 6)}] Load failed:`, err.message)
  }
  return null
}

async function saveYDocState(roomId, ydoc) {
  const filePath = `${YDOCS_DIR}/${roomId}.yjs`
  try {
    const state = Y.encodeStateAsUpdate(ydoc)
    await writeFile(filePath, state)
  } catch (err) {
    console.warn(`[${roomId.slice(0, 6)}] Save failed:`, err.message)
  }
}

async function getOrCreateRoom(roomId, libp2p, helia) {
  // Prevent race conditions with lock
  if (roomLocks.has(roomId)) {
    await roomLocks.get(roomId)
  }

  if (rooms.has(roomId)) {
    return rooms.get(roomId)
  }

  // Create lock promise
  let releaseLock
  const lockPromise = new Promise(resolve => { releaseLock = resolve })
  roomLocks.set(roomId, lockPromise)

  try {
    const ydoc = new Y.Doc()
    const manifest = ydoc.getMap('manifest')
    const chat = ydoc.getArray('chat')

    // Load persisted state
    const savedState = await loadYDocState(roomId)
    if (savedState) {
      Y.applyUpdate(ydoc, savedState)
      const files = manifest.get('files') || []
      console.log(`[${roomId.slice(0, 6)}] Restored: ${files.length} files, ${chat.length} msgs`)
    } else {
      console.log(`[${roomId.slice(0, 6)}] Created new room`)
    }

    // Auto-save on updates
    ydoc.on('update', () => {
      saveYDocState(roomId, ydoc).catch(() => { })
    })

    const room = { ydoc, manifest, chat }
    rooms.set(roomId, room)

    // Subscribe to gossipsub topic
    if (libp2p && flags.sync) {
      libp2p.services.pubsub.subscribe(ROOM_TOPIC(roomId))
      console.log(`[${roomId.slice(0, 6)}] Subscribed to gossipsub`)

      // Broadcast updates to gossipsub
      ydoc.on('update', (update, origin) => {
        if (origin === 'gossipsub') return

        libp2p.services.pubsub.publish(ROOM_TOPIC(roomId), enc({
          type: 'Y_UPDATE',
          update: Array.from(update),
          roomId
        })).catch(() => { })
      })
    }

    // Set up proactive pinning (if mirror enabled)
    if (helia && flags.mirror) {
      const pinnedCids = new Set()

      const manifestObserver = () => {
        const files = manifest.get('files') || []

        for (const file of files) {
          if (!pinnedCids.has(file.cid)) {
            pinnedCids.add(file.cid)

              ; (async () => {
                try {
                  const cidObj = CID.parse(file.cid)
                  console.log(`[${roomId.slice(0, 6)}] Pinning ${file.name}...`)

                  for await (const _ of helia.pins.add(cidObj)) {
                    // Wait for pin to complete
                  }

                  console.log(`[${roomId.slice(0, 6)}] ✓ Pinned ${file.name}`)
                } catch (err) {
                  console.warn(`[${roomId.slice(0, 6)}] Pin failed:`, err.message)
                  pinnedCids.delete(file.cid) // Allow retry
                }
              })()
          }
        }
      }

      manifest.observe(manifestObserver)
      manifestObserver() // Trigger for existing files
    }

    return room
  } finally {
    releaseLock()
    roomLocks.delete(roomId)
  }
}

// ===== MAIN =====
async function main() {
  const WS_PORT = process.env.PORT || 9004
  const TCP_PORT = process.env.TCP_PORT || 9003
  const DATA_DIR = process.env.DATA_DIR || './data'

  // Update YDOCS_DIR with custom data directory
  YDOCS_DIR = `${DATA_DIR}/ydocs`

  if (flags.sync) {
    await ensureYDocsDir()
  }

  // Initialize storage
  let blockstore, datastore
  if (flags.mirror) {
    blockstore = new FsBlockstore(`${DATA_DIR}/hub-blocks`)
    datastore = new LevelDatastore(`${DATA_DIR}/hub-datastore`)
    await datastore.open()
  } else {
    const { MemoryBlockstore } = await import('blockstore-core')
    const { MemoryDatastore } = await import('datastore-core')
    blockstore = new MemoryBlockstore()
    datastore = new MemoryDatastore()
  }

  // ===== LIBP2P =====
  const libp2pConfig = {
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${WS_PORT}/ws`,
        `/ip4/0.0.0.0/tcp/${TCP_PORT}`
      ],
    },
    transports: [webSockets(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      maxConnections: 200,
      minConnections: 0,
      inboundConnectionThreshold: 100,
    },
    peerDiscovery: [
      pubsubPeerDiscovery({ interval: 10_000, topics: [PUBSUB_PEER_DISCOVERY] })
    ],
    services: {
      identify: identify(),
      autoNat: autoNAT(),
      pubsub: gossipsub(),
    },
    datastore,
  }

  if (flags.relay) {
    libp2pConfig.services.relay = circuitRelayServer({
      reservations: {
        maxReservations: 100,
        reservationTTL: 600000,
        applyDefaultLimit: true,
      },
    })
  }

  const libp2p = await createLibp2p(libp2pConfig)
  libp2p.services.pubsub.subscribe(PUBSUB_PEER_DISCOVERY)

  console.log('Hub PeerID:', libp2p.peerId.toString())
  console.log('WS Port:', WS_PORT, '| TCP Port:', TCP_PORT)
  console.log('Data Dir:', DATA_DIR)
  console.log('Multiaddrs:', libp2p.getMultiaddrs().map(m => m.toString()).join('\n           '))

  // ===== HELIA =====
  let helia
  if (flags.mirror) {
    helia = await createHelia({ libp2p, blockstore, datastore })
    console.log('[Mirror] Enabled')
  }

  // ===== ROOM NOTIFICATION PROTOCOL =====
  if (flags.sync) {
    await libp2p.handle('/room-notify/1.0.0', async ({ stream, connection }) => {
      const remotePeer = connection.remotePeer.toString()

      try {
        const chunks = []
        for await (const chunk of stream.source) {
          chunks.push(chunk.subarray())
        }

        const data = Buffer.concat(chunks)
        const { roomId } = dec(data)

        if (!roomId) {
          console.warn(`[Notify] Invalid from ${remotePeer.slice(-8)}`)
          return
        }

        console.log(`[Notify] ${roomId.slice(0, 6)} from ${remotePeer.slice(-8)}`)

        // Create/load room (subscribes to gossipsub)
        await getOrCreateRoom(roomId, libp2p, helia)

        console.log(`[Notify] ✓ Ready for ${roomId.slice(0, 6)}`)
      } catch (err) {
        console.warn(`[Notify] Error:`, err.message)
      } finally {
        stream.close()
      }
    })

    console.log('[Notify] /room-notify/1.0.0 registered')
  }

  // ===== GOSSIPSUB SYNC =====
  if (flags.sync) {
    libp2p.services.pubsub.addEventListener('message', (evt) => {
      const topic = evt.detail.topic
      if (!topic.startsWith('wc/')) return

      const roomId = topic.slice(3)

        ; (async () => {
          try {
            const room = rooms.get(roomId) || await getOrCreateRoom(roomId, libp2p, helia)
            const msg = dec(evt.detail.data)

            if (msg.type === 'Y_UPDATE' && msg.update) {
              const update = new Uint8Array(msg.update)
              Y.applyUpdate(room.ydoc, update, 'gossipsub')
            }
            else if (msg.type === 'SNAPSHOT' && msg.update) {
              const update = new Uint8Array(msg.update)
              Y.applyUpdate(room.ydoc, update, 'gossipsub')
              const files = room.manifest.get('files') || []
              console.log(`[${roomId.slice(0, 6)}] SNAPSHOT: ${files.length} files`)
            }
            else if (msg.type === 'SNAPSHOT_REQUEST') {
              const fullState = Y.encodeStateAsUpdate(room.ydoc)
              const files = room.manifest.get('files') || []
              console.log(`[${roomId.slice(0, 6)}] SNAPSHOT_REQUEST -> sending ${files.length} files`)

              libp2p.services.pubsub.publish(ROOM_TOPIC(roomId), enc({
                type: 'SNAPSHOT',
                update: Array.from(fullState),
                roomId
              })).catch(() => { })
            }
          } catch (err) {
            console.warn(`[${roomId.slice(0, 6)}] Message error:`, err.message)
          }
        })()
    })

    console.log('[Gossipsub] Sync enabled')
  }

  // ===== LOAD PERSISTED ROOMS =====
  if (flags.sync) {
    setTimeout(async () => {
      try {
        const files = await readdir(YDOCS_DIR)
        console.log(`[Startup] Loading ${files.length} persisted rooms...`)

        for (const file of files) {
          if (file.endsWith('.yjs')) {
            const roomId = file.replace('.yjs', '')
            try {
              await getOrCreateRoom(roomId, libp2p, helia)
              console.log(`[Startup] ✓ ${roomId.slice(0, 6)}`)
            } catch (err) {
              console.warn(`[Startup] Failed ${roomId.slice(0, 6)}:`, err.message)
            }
          }
        }

        console.log(`[Startup] Loaded ${rooms.size} rooms`)
      } catch (err) {
        console.warn('[Startup] Load error:', err.message)
      }
    }, 2000)
  }

  // ===== CONNECTION LOGGING =====
  libp2p.addEventListener('peer:connect', (evt) => {
    const peerId = evt.detail.toString()
    console.log(`[Connect] ${peerId.slice(-8)}`)
  })

  libp2p.addEventListener('peer:disconnect', (evt) => {
    const peerId = evt.detail.toString()
    console.log(`[Disconnect] ${peerId.slice(-8)}`)
  })

  // ===== STATS =====
  setInterval(() => {
    const conns = libp2p.getConnections()
    const peers = libp2p.getPeers()
    console.log(`[Stats] ${conns.length} conns, ${peers.length} peers, ${rooms.size} rooms`)

    rooms.forEach((room, roomId) => {
      const files = room.manifest.get('files') || []
      const chatMsgs = room.chat.length
      console.log(`  - ${roomId.slice(0, 6)}: ${files.length} files, ${chatMsgs} msgs`)
    })
  }, 30000)
}

main().catch(err => {
  console.error('Hub failed:', err)
  process.exit(1)
})
