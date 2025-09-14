**web.cleaning**

- A featherweight, query-driven web app that wraps a browser‑persistent Helia node (OPFS first, IndexedDB fallback), supports invite-based “rooms” over libp2p pubsub, and mirrors CIDs locally (pin → fetch into OPFS). The UI never re-renders the shell; it toggles sections and updates content surgically for snappy performance.

**Background**

- Goals
  - Make small ad‑hoc “drops” easy to share via a link/QR without a backend.
  - Keep data local and durable using the browser’s Origin Private File System (OPFS).
  - Use libp2p + Helia for content addressing, discovery, and distribution.
  - Stay fast by avoiding heavy frameworks and unnecessary DOM churn.
- Design Highlights
  - OPFS Blockstore with IndexedDB fallback keeps blocks on-device and persistent.
  - Rooms over pubsub (`wc/<roomId>`) with messages: HELLO, MANIFEST, REQUEST, ACK.
  - Optional tracker node subscribes and pins requested CIDs to help others mirror.
  - UI uses query params (`?view=home|drops|rooms|peers`) and section toggling.

**Project Layout**

- `package.json` scripts for build/dev/tests and helper nodes
- `esbuild.js` bundles and copies `index.html` to `dist/`
- `src/`
  - `index.html` minimal Tailwind UI and sections
  - `main.js` app glue (uploads, pin/mirror, invites, room join)
  - `router.js` query-based router (toggles sections only)
  - `ui.js` small DOM helpers and renderers
  - `store.js` localStorage metadata for drops/rooms/peers
  - `heliaNode.js` Helia + libp2p (websockets, webtransport, webrtc, gossipsub)
  - `opfs-blockstore.js` OPFS-first blockstore with IDB fallback
  - `room.js` pubsub protocol helper
  - `peers.js` snapshots of connections by type and details
  - `constants.js` discovery topic, trackers, LS keys
- `server/`
  - `relay.js` reference libp2p relay (reuses GOLDEN conventions)
  - `tracker.js` minimalist pinning/mirroring node
- `tests/`
  - `smoke.mjs` Node smoke test for `store.js`

**Requirements**

- Node.js 20+ recommended; Node 22 works great (nvm: `nvm use 22`).
- Modern Chromium-based browser or Firefox for OPFS + WebRTC/WebTransport. Localhost counts as a secure context for required APIs.

**Quickstart**

- Install
  - `npm i`
- Configure (optional)
  - Edit `src/constants.js`:
    - `TRACKERS`: add your relay multiaddr(s) for bootstrap/dialing.
    - `PUBSUB_PEER_DISCOVERY`: keep in sync with your relay’s discovery topic.
- Run web app (dev server)
  - `npm start`
  - Open the printed URL and create a “drop”; use “Invite” to copy/QR a room link.
- Optional helpers
  - Relay: `npm run start:relay` (prints PeerID and multiaddrs)
  - Tracker (pinning): `npm run start:tracker`
  - Tracker+Mirror+Relay combo: `npm run start:newtracker` (see `server/newtracker.js` for env toggles like DHT, delegated routing, WebRTC)

**How It Works**

- Upload → Manifest
  - Files are added via `@helia/unixfs`. A simple manifest of `{ name, size, cid }[]` is created.
  - Each file is pinned locally; with the OPFS blockstore, blocks persist across reloads.
- Rooms & Invites
  - Creating a drop can also create a room (`roomId`).
  - Invite links encode the `roomId` (and optionally a bootstrap tracker multiaddr).
  - Joiners subscribe to `wc/<roomId>`, receive MANIFEST, and send REQUEST for selected CIDs.
- Mirroring
  - Host and tracker(s) pin requested CIDs. Joiners also pin to force fetch into OPFS.
  - Pinned blocks survive reloads and keep GC-safe.

**Pubsub Messages**

- Topic: `wc/<roomId>`
  - `HELLO`: `{ type, roomId, from }`
  - `MANIFEST`: `{ type, roomId, manifest }`
  - `REQUEST`: `{ type, roomId, fileCids: string[], from }`
  - `ACK`: `{ type, roomId, info }`

**Commands**

- Build once: `npm run build`
- Dev server: `npm start`
- Tests: `npm test` (Node-based smoke test)
- Relay: `npm run start:relay`
- Tracker: `npm run start:tracker`

**Tests**

- `tests/smoke.mjs`: Polyfills `localStorage` and validates `src/store.js` operations
  - Run: `npm test`
- Future work (suggested)
  - E2E with Playwright to exercise: start page → upload → create room → invite URL → join flow → request/mirror → verify pins via Helia API.
  - Unit tests for `opfs-blockstore.js` using fake FileSystemAccess APIs.

**Troubleshooting**

- Node version
  - If you see engine warnings, switch to a newer Node: `nvm use 22`.
- Secure context
  - WebRTC and Web Crypto require a secure context. Localhost is OK; otherwise use HTTPS.
- No peers
  - Ensure `TRACKERS` points at a reachable relay multiaddr and the relay is running.
- OPFS quota/availability
  - Some browsers gate OPFS behind secure context and quota prompts. Free space by removing old drops or using browser site data settings.

**Security Notes**

- Invites and room metadata are not encrypted in this baseline.
- For sensitive use, add a shared secret to the invite and encrypt MANIFEST (e.g., AES‑GCM) and/or sign messages. See “Polish next” ideas in `implement.md`.

**License**

- Same as the repository unless specified otherwise.
