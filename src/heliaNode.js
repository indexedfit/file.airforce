// @ts-check
import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { createLibp2p } from "libp2p";
import { identify } from "@libp2p/identify";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { webSockets } from "@libp2p/websockets";
import { webTransport } from "@libp2p/webtransport";
import { webRTC } from "@libp2p/webrtc";
import { pubsubPeerDiscovery } from "@libp2p/pubsub-peer-discovery";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { bootstrap } from "@libp2p/bootstrap";
import { inspectorMetrics } from "@ipshipyard/libp2p-inspector-metrics";
import { createOPFSBlockstore } from "./opfs-blockstore.js";
import { PUBSUB_PEER_DISCOVERY, TRACKERS } from "./constants.js";
import { createEd25519PeerId, exportToProtobuf, createFromProtobuf } from '@libp2p/peer-id-factory';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';

async function getOrCreatePeerId() {
  const stored = localStorage.getItem('wc:peerId');

  if (stored) {
    try {
      const binary = atob(stored);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const peerId = await createFromProtobuf(bytes);

      // Convert raw Uint8Array to PrivateKey object
      const privateKey = privateKeyFromProtobuf(peerId.privateKey);
      console.log('%cRestored peer ID', 'color: green; font-weight: bold', peerId.toString());
      return privateKey;
    } catch (err) {
      console.warn('Failed to restore peer ID:', err.message);
      localStorage.removeItem('wc:peerId');
    }
  }

  console.log('%cCreating new peer ID', 'color: orange; font-weight: bold');
  const peerId = await createEd25519PeerId();

  const protobuf = exportToProtobuf(peerId, false);
  const base64 = btoa(String.fromCharCode(...protobuf));
  localStorage.setItem('wc:peerId', base64);

  console.log('Saved peer ID:', peerId.toString());

  // Convert raw Uint8Array to PrivateKey object
  return privateKeyFromProtobuf(peerId.privateKey);
}

export async function startHelia() {
  const blockstore = await createOPFSBlockstore("wc-blocks");
  const privateKey = await getOrCreatePeerId();

  const libp2p = await createLibp2p({
    privateKey,
    metrics: inspectorMetrics(),
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [
      webSockets(),
      webTransport(),
      webRTC(),
      circuitRelayTransport({
        reservationConcurrency: 1,
      })
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
  });

  libp2p.addEventListener('peer:discovery', (evt) => {
    const peerId = evt.detail.id.toString();
    console.log(`Discovered ${peerId.slice(0, 8)}`)
    // Let identify protocol run first to get all addresses including circuit
    setTimeout(() => {
      const addrs = libp2p.peerStore.get(evt.detail.id).then(peer => {
        console.log(`Dialing ${peerId.slice(0, 8)} with ${peer.addresses.length} addresses`)
        return libp2p.dial(evt.detail.id)
      }).then(() => {
        console.log(`✓ Connected to ${peerId.slice(0, 8)}`)
      }).catch((err) => {
        console.log(`✗ Failed to dial ${peerId.slice(0, 8)}:`, err.message)
      })
    }, 2000)
  })

  // Log circuit relay events
  libp2p.addEventListener('self:peer:update', (evt) => {
    const addrs = evt.detail.peer.addresses.map(a => a.multiaddr.toString())
    const circuitAddrs = addrs.filter(a => a.includes('/p2p-circuit'))
    if (circuitAddrs.length > 0) {
      console.log(`✓ Got circuit addresses:`, circuitAddrs)
    }
  })

  libp2p.addEventListener('peer:connect', (evt) => {
    const remotePeer = evt.detail
    const conns = libp2p.getConnections(remotePeer)
    conns.forEach(conn => {
      if (conn.remoteAddr.toString().includes('/p2p-circuit')) {
        console.log(`✓ Connected via circuit: ${conn.remoteAddr.toString()}`)
      }
    })
  })

  const helia = await createHelia({
    libp2p,
    blockstore,
  });

  const fs = unixfs(helia);

  // Start Helia (starts its libp2p internally)
  if (typeof helia.start === "function") await helia.start();

  // Tag hub peers as "direct peers" for fast gossipsub delivery
  // This gives stream-like latency to known hubs without special protocols
  setTimeout(async () => {
    for (const multiaddr of TRACKERS) {
      try {
        // Extract peer ID from multiaddr string
        const parts = multiaddr.split('/p2p/')
        if (parts.length < 2) continue

        const hubPeerIdStr = parts[parts.length - 1]
        console.log(`[Gossipsub] Tagging hub as direct peer: ${hubPeerIdStr.slice(0, 16)}...`)

        // Import peerIdFromString to parse the peer ID
        const { peerIdFromString } = await import('@libp2p/peer-id')
        const hubPeerId = peerIdFromString(hubPeerIdStr)

        // Tag as direct peer (gossipsub will prioritize and send directly)
        await libp2p.peerStore.merge(hubPeerId, {
          tags: {
            'direct-peer': { value: 100 } // High priority
          }
        })

        console.log(`[Gossipsub] ✓ Tagged ${hubPeerIdStr.slice(0, 16)} as direct peer`)
      } catch (err) {
        console.warn(`[Gossipsub] Failed to tag hub as direct peer:`, err.message)
      }
    }
  }, 3000) // Wait for bootstrap connections

  return { helia, fs, libp2p };
}
