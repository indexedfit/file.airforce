// Discovery channel (keep in sync with your GOLDEN relay config)
export const PUBSUB_PEER_DISCOVERY = "gayboys-inc";

// Tracker relay(s) you'll run locally/production
// need to autogenerate some local fellows for good E2E testing!
// TODO: that.
export const TRACKERS = [
  "/ip4/127.0.0.1/tcp/9004/ws/p2p/12D3KooWRi98FHSPiXBGMvQmmfRDGqReuZGVrjErvcvGRuGM1Rue",
  // "/ip4/127.0.0.1/udp/9095/quic-v1/webtransport/certhash/uEiA4uk5FxbZHkE9C-irr-U-9P0axH2mC6vKkJviDRtlkZQ/certhash/uEiD7_PkPGxSE4ish9LEcfbs09TZv2wigDCrEQ44Y8tBPZg/p2p/12D3KooWHSPqNttFKv83BUq36c9Prk5Zc91uTs5pwHk7gV1ey58v",
  // public ones on ipfs.fyi/utils go here:
  // todo: cool DNS piggybacking and vibes.
];

// Room pubsub base
export const ROOM_TOPIC = (roomId) => `wc/${roomId}`;

// Local storage keys
export const LS_DROPS = "wc:drops";
export const LS_ROOMS = "wc:rooms";
export const LS_PEERS = "wc:peers";
