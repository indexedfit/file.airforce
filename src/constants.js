// Discovery channel (keep in sync with your GOLDEN relay config)
export const PUBSUB_PEER_DISCOVERY = 'gayboys-inc'

// Tracker relay(s) you'll run locally/production
export const TRACKERS = [
  "/ip4/127.0.0.1/tcp/9001/ws/p2p/12D3KooWRijk2xUHDgVWQXGg47b81DeA7VSP5e6MdjHfJgMuTSGL"
]

// Room pubsub base
export const ROOM_TOPIC = (roomId) => `wc/${roomId}`

// Local storage keys
export const LS_DROPS = 'wc:drops'
export const LS_ROOMS = 'wc:rooms'
export const LS_PEERS = 'wc:peers'

