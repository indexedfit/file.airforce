import { mount } from 'svelte';
import App from './App.svelte';
import { helia, fs as fsStore, roomManager, peers, peerId } from './store-svelte.js';
import { startHelia } from './lib/heliaNode.js';
import { createRoomManager } from './lib/room.js';

// Mount Svelte 5 app
const app = mount(App, {
  target: document.getElementById('app')
});

// Initialize Helia and libp2p
async function init() {
  try {
    console.log('[Init] Starting Helia...');
    const { helia: heliaNode, fs, libp2p } = await startHelia();

    // Set peerId
    peerId.set(libp2p.peerId.toString());

    // Create room manager
    const manager = createRoomManager(heliaNode, fs);
    roomManager.set(manager);
    helia.set(heliaNode);
    fsStore.set(fs);

    // Update peer count
    function updatePeers() {
      const peerList = libp2p.getPeers();
      peers.set(peerList);
    }

    // Listen for connection changes
    libp2p.addEventListener('peer:connect', updatePeers);
    libp2p.addEventListener('peer:disconnect', updatePeers);

    updatePeers();

    console.log('[Init] ✓ Helia ready, PeerID:', libp2p.peerId.toString().slice(0, 8));
  } catch (err) {
    console.error('[Init] Failed to start:', err);
  }
}

init();

export default app;
