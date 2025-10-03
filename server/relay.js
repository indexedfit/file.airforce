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
import { PUBSUB_PEER_DISCOVERY } from '../src/constants.js'

async function main() {
  const libp2p = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/9004/ws', '/ip4/0.0.0.0/tcp/9003'],
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
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 100,
          reservationTTL: 600000, // 10 min (reduced from 30)
          applyDefaultLimit: true,
        },
      }),
      pubsub: gossipsub(),
    },
  })
  libp2p.services.pubsub.subscribe(PUBSUB_PEER_DISCOVERY)
  console.log('PeerID: ', libp2p.peerId.toString())
  console.log('Multiaddrs: ', libp2p.getMultiaddrs())

  // Track peer connections with more detail
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

  // Log relay stats periodically with more detail
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
    console.log(`[Relay Stats] ${conns.length} conns, ${peers.length} peers (${transportStr})`)

    // List all connected peers
    peers.forEach(p => {
      console.log(`  - ${p.toString().slice(-16)}`)
    })
  }, 30000)
}
main()

