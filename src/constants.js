// Discovery channel (keep in sync with your GOLDEN relay config)
export const PUBSUB_PEER_DISCOVERY = "gayboys-inc";

// Tracker relay(s) you'll run locally/production
// need to autogenerate some local fellows for good E2E testing!
// TODO: that.
export const TRACKERS = [
  "/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3KooWQSnW1yKAH7DuJnNnjaojM5HjJRMsMVC8cnnfXup6xyKs",
  // public ones on ipfs.fyi/utils go here:
  // todo: cool DNS piggybacking and vibes.
];

// Room pubsub base
export const ROOM_TOPIC = (roomId) => `wc/${roomId}`;

// Local storage keys
export const LS_DROPS = "wc:drops";
export const LS_ROOMS = "wc:rooms";
export const LS_PEERS = "wc:peers";
