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
import { FsBlockstore } from 'blockstore-fs'
import { LevelDatastore } from 'datastore-level'
import { CID } from 'multiformats/cid'
import { createServer } from 'http'
import { pushable } from 'it-pushable'
import { pipe } from 'it-pipe'
import * as Y from 'yjs'
import { PUBSUB_PEER_DISCOVERY, ROOM_TOPIC } from '../src/constants.js'

// ===== CLI FLAGS =====
const args = process.argv.slice(2)
const flags = {
  relay: args.includes('--relay') || args.includes('--relay-only'),
  mirror: args.includes('--mirror') || args.includes('--mirror-only'),
  sync: args.includes('--sync') || args.includes('--sync-only'),
}

// Default: all enabled if no --*-only flag specified
const anyOnly = args.some(a => a.endsWith('-only'))
if (!anyOnly) {
  flags.relay = flags.mirror = flags.sync = true
}

console.log('Hub modes:', flags)

// ===== Y.JS PROTOCOL CONSTANTS =====
const Y_SYNC_PROTOCOL = '/y-sync/1.0.0'
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj))
const dec = (buf) => JSON.parse(new TextDecoder().decode(buf))

// ===== Y.JS ROOM MANAGER =====
// roomId -> { ydoc: Y.Doc, manifest: Y.Map, chat: Y.Array, streams: Map<peerId, pushable> }
const rooms = new Map()

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    const ydoc = new Y.Doc()
    const manifest = ydoc.getMap('manifest')
    const chat = ydoc.getArray('chat')
    const streams = new Map()

    console.log(`[Hub] Created Y.Doc for room ${roomId.slice(0, 6)}`)

    rooms.set(roomId, { ydoc, manifest, chat, streams })
  }
  return rooms.get(roomId)
}

// ===== MAIN =====
async function main() {
  const WS_PORT = process.env.PORT || 9004
  const TCP_PORT = process.env.TCP_PORT || 9003
  const HTTP_PORT = process.env.HTTP_PORT || 9007

  // Initialize blockstore/datastore if mirror enabled
  let blockstore, datastore
  if (flags.mirror) {
    blockstore = new FsBlockstore('./data/hub-blocks')
    datastore = new LevelDatastore('./data/hub-datastore')
    await datastore.open()
  } else {
    // Use in-memory for relay/sync-only modes
    const { MemoryBlockstore } = await import('blockstore-core')
    const { MemoryDatastore } = await import('datastore-core')
    blockstore = new MemoryBlockstore()
    datastore = new MemoryDatastore()
  }

  // ===== LIBP2P SETUP =====
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
    services: {
      identify: identify(),
      autoNat: autoNAT(),
      pubsub: gossipsub(),
    },
    datastore,
  }

  // Add circuit relay if enabled
  if (flags.relay) {
    libp2pConfig.services.relay = circuitRelayServer({
      reservations: {
        maxReservations: 100,
        reservationTTL: 600000, // 10 min
        applyDefaultLimit: true,
      },
    })
  }

  const libp2p = await createLibp2p(libp2pConfig)

  // Subscribe to peer discovery topic
  libp2p.services.pubsub.subscribe(PUBSUB_PEER_DISCOVERY)

  console.log('Hub PeerID:', libp2p.peerId.toString())
  console.log('WS Port:', WS_PORT, '| TCP Port:', TCP_PORT, '| HTTP Port:', HTTP_PORT)
  console.log('Multiaddrs:', libp2p.getMultiaddrs().map(m => m.toString()).join('\n           '))

  // ===== HELIA (if mirror enabled) =====
  let helia
  if (flags.mirror) {
    helia = await createHelia({ libp2p, blockstore, datastore })
    console.log('[Mirror] Helia initialized')
  }

  // ===== Y.JS SYNC PROTOCOL =====
  if (flags.sync) {
    await libp2p.handle(Y_SYNC_PROTOCOL, async ({ stream, connection }) => {
      const remotePeer = connection.remotePeer.toString()
      console.log(`[Y-Sync] New stream from ${remotePeer.slice(-16)}`)

      const outgoing = pushable({ objectMode: false })
      let roomId = null
      let room = null

      try {
        // Pipe outgoing messages to sink
        pipe(outgoing, stream.sink)

        // Read messages from source
        const reader = stream.source[Symbol.asyncIterator]()

        // Read first message (JOIN_ROOM)
        const { value: firstChunk, done: firstDone } = await reader.next()
        if (firstDone || !firstChunk) {
          throw new Error('No JOIN_ROOM message received')
        }

        const firstMsg = dec(firstChunk.subarray())
        if (firstMsg.type !== 'JOIN_ROOM' || !firstMsg.roomId) {
          throw new Error('First message must be JOIN_ROOM with roomId')
        }

        roomId = firstMsg.roomId
        room = getOrCreateRoom(roomId)
        room.streams.set(remotePeer, outgoing)

        console.log(`[Y-Sync] ${remotePeer.slice(-16)} joined room ${roomId.slice(0, 6)}`)

        // Send full state immediately
        const fullState = Y.encodeStateAsUpdate(room.ydoc)
        outgoing.push(enc({
          type: 'SYNC_FULL_STATE',
          update: Array.from(fullState),
          roomId
        }))

        console.log(`[Y-Sync] Sent full state (${fullState.length} bytes) to ${remotePeer.slice(-16)}`)

        // Listen for subsequent updates
        for await (const chunk of reader) {
          try {
            const msg = dec(chunk.subarray())

            if (msg.type === 'Y_UPDATE' && msg.update) {
              const update = new Uint8Array(msg.update)
              console.log(`[Y-Sync] Received Y_UPDATE (${update.length} bytes) from ${remotePeer.slice(-16)}`)

              // Apply to local Y.Doc (triggers broadcast to other streams + gossipsub)
              Y.applyUpdate(room.ydoc, update, 'stream')
            }
          } catch (err) {
            console.warn(`[Y-Sync] Failed to process message:`, err.message)
          }
        }

      } catch (err) {
        console.error(`[Y-Sync] Stream error:`, err.message)
      } finally {
        if (room && remotePeer) {
          room.streams.delete(remotePeer)
          console.log(`[Y-Sync] ${remotePeer.slice(-16)} left room ${roomId?.slice(0, 6) || 'unknown'}`)
        }
        outgoing.end()
      }
    })

    console.log(`[Y-Sync] Protocol handler registered: ${Y_SYNC_PROTOCOL}`)

    // ===== GOSSIPSUB ↔ STREAM BRIDGE =====
    // Listen to all room topics and bridge to streams
    libp2p.services.pubsub.addEventListener('message', (evt) => {
      const topic = evt.detail.topic
      if (!topic.startsWith('wc/')) return

      const roomId = topic.slice(3) // Extract roomId from "wc/<roomId>"
      const room = rooms.get(roomId)
      if (!room) return

      try {
        const msg = dec(evt.detail.data)

        // Only bridge Y.js updates (not metadata like SNAPSHOT_REQUEST)
        if (msg.type === 'Y_UPDATE' && msg.update) {
          const update = new Uint8Array(msg.update)
          console.log(`[Bridge] Gossipsub → Y.Doc: room ${roomId.slice(0, 6)}, ${update.length} bytes`)

          // Apply to Y.Doc (this will trigger broadcast to streams)
          Y.applyUpdate(room.ydoc, update, 'gossipsub')
        }
      } catch (err) {
        console.warn('[Bridge] Failed to process gossipsub message:', err.message)
      }
    })

    // When Y.Doc updates, broadcast to both streams and gossipsub
    // (We'll set up observers when rooms are created)
    function setupRoomBroadcast(roomId, ydoc, streams) {
      ydoc.on('update', (update, origin) => {
        // Don't echo back to the origin
        if (origin === 'gossipsub' || origin === 'stream') return

        const updateMsg = enc({
          type: 'Y_UPDATE',
          update: Array.from(update),
          roomId
        })

        // Broadcast to all connected streams
        streams.forEach((outgoing, peerId) => {
          try {
            outgoing.push(updateMsg)
          } catch (err) {
            console.warn(`[Y-Sync] Failed to send to ${peerId.slice(-16)}:`, err.message)
            streams.delete(peerId)
          }
        })

        // Broadcast to gossipsub
        libp2p.services.pubsub.publish(ROOM_TOPIC(roomId), updateMsg)
          .catch(err => {
            if (!err.message?.includes('NoPeersSubscribedToTopic')) {
              console.warn(`[Bridge] Gossipsub publish failed:`, err.message)
            }
          })

        console.log(`[Bridge] Y.Doc → Streams (${streams.size}) + Gossipsub: ${update.length} bytes`)
      })
    }

    // Patch getOrCreateRoom to set up broadcast
    const originalGetOrCreateRoom = getOrCreateRoom
    getOrCreateRoom = function(roomId) {
      const room = originalGetOrCreateRoom(roomId)
      if (!room._broadcastSetup) {
        setupRoomBroadcast(roomId, room.ydoc, room.streams)
        room._broadcastSetup = true

        // Subscribe to gossipsub topic for this room
        libp2p.services.pubsub.subscribe(ROOM_TOPIC(roomId))
        console.log(`[Bridge] Subscribed to gossipsub topic: ${ROOM_TOPIC(roomId)}`)
      }
      return room
    }
  }

  // ===== MIRROR HTTP API =====
  if (flags.mirror) {
    const server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'POST' && req.url === '/upload') {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks)
            const { blocks } = JSON.parse(body.toString())

            if (!Array.isArray(blocks) || blocks.length === 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'blocks array required' }))
              return
            }

            const stored = []
            const failed = []

            for (const { cid, bytes } of blocks) {
              try {
                const cidObj = CID.parse(cid)
                const data = Uint8Array.from(Buffer.from(bytes, 'base64'))
                await blockstore.put(cidObj, data)
                await helia.pins.add(cidObj)
                stored.push(cid)
                console.log(`[Mirror] Stored ${cid}`)
              } catch (err) {
                console.error(`[Mirror] Store error ${cid}:`, err.message)
                failed.push({ cid, error: err.message })
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ stored, failed }))
          } catch (err) {
            console.error('[Mirror] API error:', err)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    server.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log(`[Mirror] HTTP API listening on port ${HTTP_PORT}`)
    })
  }

  // ===== CONNECTION LOGGING =====
  libp2p.addEventListener('peer:connect', (evt) => {
    const remotePeer = evt.detail
    const peerId = remotePeer.toString()
    const conns = libp2p.getConnections(remotePeer)
    const transports = conns.map(c => {
      const addr = c.remoteAddr.toString()
      if (addr.includes('/ws/')) return 'WS'
      if (addr.includes('/tcp/')) return 'TCP'
      if (addr.includes('/p2p-circuit')) return 'Circuit'
      return 'Other'
    }).join(',')
    console.log(`[Connect] ${peerId.slice(-16)} via ${transports}`)
  })

  libp2p.addEventListener('peer:disconnect', (evt) => {
    const peerId = evt.detail.toString()
    console.log(`[Disconnect] ${peerId.slice(-16)}`)
  })

  // ===== STATS =====
  setInterval(() => {
    const conns = libp2p.getConnections()
    const peers = libp2p.getPeers()
    const byTransport = {}
    conns.forEach(c => {
      const addr = c.remoteAddr.toString()
      let type = 'Other'
      if (addr.includes('/ws/')) type = 'WS'
      else if (addr.includes('/tcp/')) type = 'TCP'
      else if (addr.includes('/p2p-circuit')) type = 'Circuit'
      byTransport[type] = (byTransport[type] || 0) + 1
    })
    const transportStr = Object.entries(byTransport).map(([k,v]) => `${k}:${v}`).join(' ')
    console.log(`[Stats] ${conns.length} conns, ${peers.length} peers (${transportStr}), ${rooms.size} rooms`)

    // Room stats
    rooms.forEach((room, roomId) => {
      const files = room.manifest.get('files') || []
      const chatMsgs = room.chat.length
      const streamCount = room.streams.size
      console.log(`  - Room ${roomId.slice(0, 6)}: ${files.length} files, ${chatMsgs} chat msgs, ${streamCount} streams`)
    })
  }, 30000)
}

main().catch(err => {
  console.error('Hub failed to start:', err)
  process.exit(1)
})
