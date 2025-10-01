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

export async function startHelia() {
  const blockstore = await createOPFSBlockstore("wc-blocks");

  const libp2p = await createLibp2p({
    metrics: inspectorMetrics(),
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [
      webSockets(),
      webTransport(),
      webRTC(),
      circuitRelayTransport()
    ],
    connectionEncrypters: [noise()],
    connectionManager: { maxConnections: 50, minConnections: 2, autoDial: true },
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
    console.log(`Discovered ${peerId.slice(0, 8)}, dialing...`)
    libp2p.dial(evt.detail.id).then(() => {
      console.log(`✓ Connected to ${peerId.slice(0, 8)}`)
    }).catch((err) => {
      console.log(`✗ Failed to dial ${peerId.slice(0, 8)}:`, err.message)
    })
  })

  const helia = await createHelia({
    libp2p,
    blockstore,
  });

  const fs = unixfs(helia);

  // Start Helia (starts its libp2p internally)
  if (typeof helia.start === "function") await helia.start();

  return { helia, fs, libp2p };
}
