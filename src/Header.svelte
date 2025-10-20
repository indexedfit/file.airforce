<script>
  export let peerCount = 0;
  export let peerId = '';

  let showDetails = false;

  function toggleDetails() {
    showDetails = !showDetails;
  }

  function goHome() {
    history.pushState(null, '', '/');
    window.dispatchEvent(new Event('popstate'));
  }
</script>

<header class="bg-white sticky top-0 z-20 border-b">
  <div class="container mx-auto px-4 py-3 flex items-center gap-3">
    <button on:click={goHome} class="font-bold text-xl hover:text-blue-600">
      file.airforce
    </button>
    <div class="ml-auto text-sm flex items-center gap-3">
      <div class="flex items-baseline gap-1">
        <span class="font-semibold">{peerCount}</span>
        <span class="text-xs text-gray-500">peers</span>
      </div>
      <button
        on:click={toggleDetails}
        class="px-2 py-1 border rounded text-xs hover:bg-gray-50"
      >
        Details
      </button>
    </div>
  </div>

  {#if showDetails}
    <div class="border-t bg-gray-50 px-4 py-3">
      <div class="text-xs text-gray-500">Peer ID</div>
      <div class="font-mono text-xs break-all select-all">{peerId || '—'}</div>
    </div>
  {/if}
</header>
