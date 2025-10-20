<script>
  import { onMount } from 'svelte';
  import Header from './Header.svelte';
  import Upload from './Upload.svelte';
  import Room from './Room.svelte';
  import { peers, peerId } from './store-svelte.js';

  let currentView = 'home';
  let currentRoom = null;
  let toast = { show: false, message: '' };

  function updateView() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') || 'home';
    const room = params.get('room');
    currentView = view === 'rooms' && room ? 'room' : 'home';
    currentRoom = room;
  }

  function showToast(message) {
    toast = { show: true, message };
    setTimeout(() => toast = { show: false, message: '' }, 2000);
  }

  onMount(() => {
    updateView();
    window.addEventListener('popstate', updateView);
    return () => window.removeEventListener('popstate', updateView);
  });
</script>

<div class="min-h-screen bg-gray-50">
  <Header peerCount={$peers.length} peerId={$peerId} />

  <main class="container mx-auto px-4 py-6">
    {#if currentView === 'home'}
      <Upload on:toast={(e) => showToast(e.detail)} />
    {:else if currentView === 'room' && currentRoom}
      <Room roomId={currentRoom} on:toast={(e) => showToast(e.detail)} />
    {/if}
  </main>

  {#if toast.show}
    <div class="fixed bottom-4 left-1/2 -translate-x-1/2 bg-black text-white text-sm px-3 py-2 rounded">
      {toast.message}
    </div>
  {/if}
</div>
