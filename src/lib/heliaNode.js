// @ts-check
import { createHelia } from 'helia'
import { unixfs } from '@helia/unixfs'
import { createLibp2p } from 'libp2p'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { webTransport } from '@libp2p/webtransport'
import { webRTC } from '@libp2p/webrtc'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { bootstrap } from '@libp2p/bootstrap'
import { inspectorMetrics } from '@ipshipyard/libp2p-inspector-metrics'
import { createOPFSBlockstore } from './opfs-blockstore.js'
import { PUBSUB_PEER_DISCOVERY, TRACKERS } from './constants.js'
import { createEd25519PeerId, exportToProtobuf, createFromProtobuf } from '@libp2p/peer-id-factory'
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys'

async function getOrCreatePeerId() {
  const stored = localStorage.getItem('wc:peerId')

  if (stored) {
    try {
      const binary = atob(stored)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      const peerId = await createFromProtobuf(bytes)
      const privateKey = privateKeyFromProtobuf(peerId.privateKey)
      console.log('Restored peer ID:', peerId.toString().slice(0, 16))
      return privateKey
    } catch (err) {
      console.warn('Failed to restore peer ID:', err.message)
      localStorage.removeItem('wc:peerId')
    }
  }

  console.log('Creating new peer ID')
  const peerId = await createEd25519PeerId()
  const protobuf = exportToProtobuf(peerId, false)
  const base64 = btoa(String.fromCharCode(...protobuf))
  localStorage.setItem('wc:peerId', base64)
  console.log('Saved peer ID:', peerId.toString().slice(0, 16))
  return privateKeyFromProtobuf(peerId.privateKey)
}

export async function startHelia() {
  const blockstore = await createOPFSBlockstore('wc-blocks')
  const privateKey = await getOrCreatePeerId()

  const libp2p = await createLibp2p({
    privateKey,
    metrics: inspectorMetrics(),
    addresses: { listen: ['/p2p-circuit', '/webrtc'] },
    transports: [
      webSockets(),
      webTransport(),
      webRTC(),
      circuitRelayTransport({ reservationConcurrency: 1 })
    ],
    connectionEncrypters: [noise()],
    connectionManager: {
      maxConnections: 50,
      minConnections: 2,
      autoDial: true,
      inboundConnectionThreshold: 25,
      maxIncomingPendingConnections: 10,
    },
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
      bootstrap({ list: TRACKERS }),
      pubsubPeerDiscovery({ interval: 3_000, topics: [PUBSUB_PEER_DISCOVERY] }),
    ],
    services: {
      pubsub: gossipsub({ allowPublishToZeroPeers: true }),
      identify: identify(),
    },
  })

  // Tag hubs as direct peers for fast gossipsub routing
  libp2p.addEventListener('peer:connect', async (evt) => {
    const remotePeer = evt.detail
    const peerId = remotePeer.toString()

    const isHub = TRACKERS.some(addr => addr.includes(peerId))
    if (isHub) {
      try {
        await libp2p.peerStore.merge(remotePeer, {
          tags: { 'direct-peer': { value: 100 } }
        })
        console.log(`Tagged hub ${peerId.slice(0, 8)} as direct peer`)
      } catch (err) {
        console.warn('Failed to tag hub:', err.message)
      }
    }
  })

  const helia = await createHelia({ libp2p, blockstore })
  const fs = unixfs(helia)

  if (typeof helia.start === 'function') await helia.start()

  return { helia, fs, libp2p }
}
