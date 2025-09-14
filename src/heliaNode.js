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

  // special case for invite via 'tracker' (relay?)
  // use tracker(s) from invite URL when present so all participants share the same relay
  const TRACKERS_ACTIVE = (() => {
    try {
      const sp = new URLSearchParams(globalThis.location?.search || "");
      const t = sp.get("tracker");
      if (!t) return TRACKERS;
      return decodeURIComponent(t).split("|").filter(Boolean);
    } catch {
      return TRACKERS;
    }
  })();

  const libp2p = await createLibp2p({
    metrics: inspectorMetrics(),
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [
      webSockets(),
      webTransport(),
      webRTC(),
      circuitRelayTransport(),
    ],
    connectionEncrypters: [noise()],
    // Ensure discovered peers are dialed so bitswap has paths immediately
    connectionManager: {
      maxConnections: 12,
      autoDial: true,
    },
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: async () => false,
    },
    peerDiscovery: [
      bootstrap({ list: TRACKERS_ACTIVE }),
      pubsubPeerDiscovery({
        interval: 10_000,
        topics: [PUBSUB_PEER_DISCOVERY],
      }),
    ],
    services: {
      pubsub: gossipsub(),
      identify: identify(),
    },
  });

  const helia = await createHelia({
    libp2p,
    blockstore,
  });

  const fs = unixfs(helia);

  // Start Helia (starts its libp2p internally)
  if (typeof helia.start === "function") await helia.start();

  return { helia, fs, libp2p };
}
