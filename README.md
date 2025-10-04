# file.airforce

Browser-based peer-to-peer file sharing using Helia (IPFS), libp2p, and Y.js CRDTs. Create invite-based "rooms" to share files without a backend server. Files persist in your browser using OPFS.

## Key Technologies

- **Helia + libp2p**: Content addressing, peer discovery, and data distribution
- **Y.js CRDTs**: Collaborative state synchronization (manifest + chat)
- **OPFS + IndexedDB**: Persistent browser storage for IPFS blocks
- **React**: UI framework
- **Vite**: Build tool and dev server

## Quick Start

```bash
# Install dependencies (Node.js 20+, Node 22 recommended)
npm install

# Start dev server
npm start

# Optional: Run relay for local testing
npm run relay
```

### First Use

1. Open the app and upload files
2. Room is created automatically with an invite link
3. Share the invite link or QR code
4. Joiners get the manifest and can download files P2P

## Architecture

### Storage & Persistence

**OPFS Blockstore** (`src/opfs-blockstore.js`)
- Primary storage: OPFS (Origin Private File System) with nested directory structure
  - Path: `blocks/<first2>/<next2>/<cid>.bin`
  - Survives page reloads, persistent in browser storage
- Fallback: IndexedDB for browsers without OPFS support
- Implements Helia blockstore interface: `get`, `put`, `has`, `delete`, `putMany`, `getMany`

**Y.js Document Storage** (`src/ydoc.js`)
- Y.js state persisted to OPFS or IndexedDB under `ydocs/` directory
- Loads existing state before network activity (prevents race conditions)
- Auto-saves on every Y.js update

**Metadata Storage** (`src/store.js`)
- localStorage for drops/rooms list (JSON serialized)
- Keys: `wc:drops`, `wc:rooms`, `wc:peers`, `wc:peerId`

### Helia + libp2p Setup

**Node Creation** (`src/heliaNode.js`)
- **Persistent Peer ID**: Stored in localStorage (`wc:peerId`), restored on reload
- **Transports**: WebSockets, WebTransport, WebRTC, Circuit Relay
- **Peer Discovery**:
  - Bootstrap nodes from `TRACKERS` array
  - Pubsub peer discovery via gossipsub topic (`PUBSUB_PEER_DISCOVERY`)
- **Pubsub**: Gossipsub for room messaging and peer discovery
- **Connection Management**: Auto-dial discovered peers, maintain 2-50 connections

**Block Storage**: OPFS-first blockstore for persistent browser storage

### Room & Sync Mechanism

**Y.js CRDT Synchronization** (`src/ydoc.js`)

Each room has a Y.js document with two CRDTs:
- `manifest` (Y.Map): Shared file list `{ files: [{name, size, cid}], updatedAt }`
- `chat` (Y.Array): Chat messages `[{text, from, ts, msgId}]`

**Sync Protocol** (over libp2p pubsub topic `wc/<roomId>`):

1. **Y_UPDATE**: Incremental CRDT state updates
   - Broadcast automatically when local Y.js doc changes
   - Applied to remote doc on receive
   - **Marks peer as synced** (prevents infinite snapshot requests)

2. **SNAPSHOT_REQUEST**: Request full state from peers
   - Sent after 1s delay on join (allows peer connections to form)
   - Retried every 5s until synced

3. **SNAPSHOT**: Full CRDT state response
   - Sent when receiving SNAPSHOT_REQUEST
   - Responder also sends their state back for bidirectional sync
   - Marks peer as synced

4. **FILE_REQUEST**: Lightweight file request hint (non-CRDT)
   - Published to room topic when user requests files
   - Triggers peers to pin CIDs (helps bitswap distribution)

**Sync State Machine**:
- `loading` → `syncing` → `synced`
- Only SNAPSHOT or Y_UPDATE mark state as `synced`
- Prevents retry loop spam

**Important Implementation Details**:
- Persistence loads BEFORE network activity
- Observers cleaned up on rejoin to prevent memory leaks
- Host sets manifest only on first join
- Every Y.js update triggers observers

### Room Manager

**Room Operations** (`src/room.js` → `createRoomManager()`)
- `join(roomId, options)`: Unified join for host/joiner
  - Host: Sets initial manifest on first join
  - Joiner: Subscribes to manifest/chat updates
  - Callbacks: `onManifestUpdate`, `onNewFiles`
- `setManifest(roomId, manifest)`: Update manifest via Y.js
- `getManifest(roomId)`: Read current manifest from Y.js
- `sendChat(roomId, text, msgId)`: Add message to Y.js chat array
- `requestFiles(roomId, fileCids)`: Publish FILE_REQUEST message

**Room UI** (`src/room.js` → `RoomUI` class)
- Manages active room view rendering
- Binds file action buttons (open, download)
- Handles chat input and messages
- Keyboard navigation for file list
- Auto-subscribes to chat updates

### Data Flow

```
Upload Files
  ↓
@helia/unixfs adds files → blocks stored in OPFS blockstore
  ↓
Manifest created: { files: [{name, size, cid}], updatedAt }
  ↓
Files pinned locally (prevents GC)
  ↓
Room created with roomId
  ↓
Y.js doc initialized, manifest set via Y.Map
  ↓
Subscribe to pubsub topic: wc/<roomId>
  ↓
Invite URL: ?view=rooms&room=<roomId>
```

```
Joiner Flow
  ↓
Open invite URL
  ↓
Subscribe to wc/<roomId>
  ↓
Y.js doc loads from local storage (if exists)
  ↓
Send SNAPSHOT_REQUEST after 1s
  ↓
Receive Y_UPDATE or SNAPSHOT → apply to Y.js doc
  ↓
Manifest observer fires → UI updates with file list
  ↓
User requests files → publish FILE_REQUEST
  ↓
Pin CIDs → bitswap fetches blocks → OPFS storage
  ↓
onNewFiles callback → auto-pin files
```

### UI & Routing

**Bootstrap** (`src/bootstrap.js`)
- Main app initialization and event binding
- Query-based routing: `?view=home|drops|rooms|peers`
- Auto-creates drop+room when files uploaded
- Handles room file additions and manifest merging

**Rendering** (`src/ui.js`)
- Surgical DOM updates (no full re-renders)
- File list, chat messages, peer info, addresses
- Progress indicators for uploads/downloads

**File Manager** (`src/file-manager.js`)
- `addFilesAndCreateManifest()`: Upload files via Helia unixfs
- `fetchFileAsBlob()`: Download files from IPFS with progress
- `openFile()`, `downloadFile()`: Browser file operations

## Project Structure

```
src/
├── heliaNode.js          # Helia + libp2p initialization
├── opfs-blockstore.js    # OPFS/IndexedDB persistent blockstore
├── ydoc.js               # Y.js CRDT manager & sync protocol
├── room.js               # Room manager + Room UI
├── bootstrap.js          # App initialization & routing
├── ui.js                 # DOM rendering helpers
├── store.js              # localStorage metadata
├── file-manager.js       # File upload/download
├── constants.js          # Config (TRACKERS, discovery topic)
├── App.jsx               # React app root
└── main.jsx              # React entry point

server/
├── relay.js              # libp2p relay node (WebSocket + TCP)
└── tracker.js            # Pinning/mirroring helper node

tests/
├── smoke.mjs             # Node smoke tests
├── router.mjs            # Routing logic tests
└── e2e/*.spec.js         # Playwright E2E tests
```

## Configuration

**Bootstrap Relays** (`src/constants.js`)
```js
export const TRACKERS = [
  "/ip4/127.0.0.1/tcp/9004/ws/p2p/<peerId>",
  // Add your relay multiaddrs here
];
```

**Peer Discovery Topic** (`src/constants.js`)
```js
export const PUBSUB_PEER_DISCOVERY = "gayboys-inc";
// Keep in sync with your relay's discovery topic
```

## Commands

```bash
# Development
npm start                # Dev server (Vite)
npm run build            # Production build to dist/
npm run preview          # Preview production build

# Testing
npm test                 # Node smoke tests
npm run test:e2e         # Playwright E2E tests

# Helper Nodes
npm run relay            # libp2p relay (TCP 9003 + WS 9004)
npm run tracker          # Pinning/mirroring tracker node
```

## Common Issues

**No peers connecting**
- Verify relay is running: `npm run relay`
- Check `TRACKERS` multiaddrs in `src/constants.js`
- Ensure relay PeerID matches multiaddr

**Manifest not syncing**
- Check browser console for Y.js logs: `[roomId] Received Y_UPDATE`
- Verify peer count in logs: `Broadcasting Y_UPDATE to N peers`
- If `N = 0`, gossipsub mesh hasn't formed (wait a few seconds)

**OPFS errors**
- Requires secure context (HTTPS or localhost)
- Check browser quota and available storage
- Falls back to IndexedDB automatically

**WebRTC failures**
- Ensure relay has public IP or use circuit relay transport
- Circuit relay reservations logged: `✓ Circuit relay reservation: ...`

## Security Notes

- Invites and room metadata are **not encrypted** in this baseline
- For sensitive use: add shared secret to invite URL and encrypt manifest (AES-GCM)
- Consider signing messages for authenticity

## License

Same as repository unless specified otherwise.
