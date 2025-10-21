<script>
  import { onMount } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import { fs, roomManager } from './store-svelte.js';
  import { addFilesAndCreateManifest } from './lib/file-manager.js';
  import { saveRoom, getRooms } from './lib/store.js';

  const dispatch = createEventDispatcher();

  let selectedFiles = [];
  let uploading = false;
  let progress = { percent: 0, label: '' };
  let recentRooms = [];

  onMount(() => {
    recentRooms = getRooms().sort((a, b) => (b.lastSeen || b.createdAt) - (a.lastSeen || a.createdAt));
  });

  async function handleFileSelect(event) {
    const files = event.target?.files || event.dataTransfer?.files;
    if (files && files.length > 0) {
      selectedFiles = Array.from(files);
      await uploadFiles();
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    handleFileSelect(event);
  }

  function handleDragOver(event) {
    event.preventDefault();
  }

  async function uploadFiles() {
    if (!selectedFiles.length || !$fs) return;

    uploading = true;
    progress = { percent: 0, label: 'Preparing files...' };

    try {
      const manifest = await addFilesAndCreateManifest($fs, selectedFiles, (loaded, total) => {
        progress = {
          percent: Math.round((loaded / total) * 100),
          label: `${loaded} / ${total} files`
        };
      });

      const roomId = crypto.randomUUID();

      if ($roomManager) {
        await $roomManager.join(roomId, { isHost: true });
        await $roomManager.setManifest(roomId, manifest);
      }

      // Mark as host in storage
      saveRoom({ id: roomId, roomId, name: roomId.slice(0, 8), createdAt: Date.now(), isHost: true });

      // Navigate to room view
      const url = new URLSearchParams();
      url.set('view', 'rooms');
      url.set('room', roomId);
      history.pushState(null, '', `?${url.toString()}`);
      window.dispatchEvent(new Event('popstate'));

      dispatch('toast', 'Room created!');
    } catch (err) {
      console.error('Upload failed:', err);
      dispatch('toast', 'Upload failed');
    } finally {
      uploading = false;
      selectedFiles = [];
    }
  }

  function openRoom(roomId) {
    const url = new URLSearchParams();
    url.set('view', 'rooms');
    url.set('room', roomId);
    history.pushState(null, '', `?${url.toString()}`);
    window.dispatchEvent(new Event('popstate'));
  }

  function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  }
</script>

<div class="bg-white border rounded p-4">
  <h2 class="font-semibold mb-3">Create a drop</h2>

  <div
    role="button"
    tabindex="0"
    class="border-2 border-dashed rounded p-6 text-center text-sm text-gray-500 bg-gray-50 hover:bg-white"
    on:drop={handleDrop}
    on:dragover={handleDragOver}
  >
    <input
      type="file"
      multiple
      class="hidden"
      id="file-input"
      on:change={handleFileSelect}
    />
    <p>
      Drag & drop files here, or
      <label for="file-input" class="underline cursor-pointer">browse</label>
    </p>
  </div>

  {#if uploading}
    <div class="mt-3">
      <div class="text-sm text-gray-700">{progress.label}</div>
      <div class="w-full bg-gray-200 h-2 rounded mt-1">
        <div class="bg-blue-500 h-2 rounded" style="width: {progress.percent}%"></div>
      </div>
    </div>
  {/if}
</div>

{#if recentRooms.length > 0}
  <div class="bg-white border rounded p-4 mt-4">
    <h2 class="font-semibold mb-3">Recent rooms</h2>
    <ul class="space-y-2">
      {#each recentRooms as room}
        <li class="flex items-center justify-between p-2 hover:bg-gray-50 rounded">
          <div>
            <div class="text-sm font-medium">{room.name || 'Unnamed room'}</div>
            <div class="text-xs text-gray-500">{formatDate(room.lastSeen || room.createdAt)}</div>
          </div>
          <button
            on:click={() => openRoom(room.roomId)}
            class="px-3 py-1 border rounded text-xs hover:bg-gray-100"
          >
            Open
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
