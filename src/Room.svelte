<script>
  import { onDestroy, createEventDispatcher } from "svelte";
  import { fs, roomManager } from "./store-svelte.js";
  import {
    fetchFileAsBlob,
    downloadFile,
    addFilesAndCreateManifest,
  } from "./lib/file-manager.js";
  import { getRoom, saveRoom } from "./lib/store.js";
  import QRCode from "qrcode";

  export let roomId;

  const dispatch = createEventDispatcher();

  let manifest = { files: [], updatedAt: null };
  let chatMessages = [];
  let newMessage = "";
  let downloading = new Set();
  let showShareModal = false;
  let inviteLink = "";
  let qrCodeUrl = "";
  let isHost = false;
  let uploading = false;
  let uploadProgress = { percent: 0, label: "" };
  let roomName = "";
  let editingName = false;

  let unsubscribeManifest;
  let unsubscribeChat;
  let chatContainer;
  let isAtBottom = true;

  $: {
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set("view", "rooms");
    url.searchParams.set("room", roomId);
    inviteLink = url.toString();
  }

  function checkScroll() {
    if (!chatContainer) return;
    const threshold = 50;
    isAtBottom =
      chatContainer.scrollHeight -
        chatContainer.scrollTop -
        chatContainer.clientHeight <
      threshold;
  }

  $: if (chatMessages.length && chatContainer && isAtBottom) {
    setTimeout(() => {
      if (chatContainer && isAtBottom)
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }, 50);
  }

  async function joinRoom() {
    if (!$roomManager || !roomId) {
      console.log("[Room] Waiting for roomManager to initialize...");
      return;
    }

    console.log("[Room] Joining room:", roomId);

    try {
      const existing = getRoom(roomId);
      isHost = existing?.isHost || false;
      roomName = existing?.name || roomId.slice(0, 8);

      await $roomManager.join(roomId, { isHost });

      unsubscribeManifest = await $roomManager.onManifest(
        roomId,
        (newManifest) => {
          console.log("[Room] Manifest update:", newManifest);
          manifest = newManifest || { files: [], updatedAt: null };
        }
      );

      unsubscribeChat = await $roomManager.onChat(roomId, (messages) => {
        console.log("[Room] Chat update:", messages?.length, "messages");
        chatMessages = messages || [];
      });

      if (!existing) {
        saveRoom({
          id: roomId,
          roomId,
          name: roomName,
          createdAt: Date.now(),
          isHost: false,
        });
      } else {
        // Update lastSeen on every join
        saveRoom({ id: roomId, roomId });
      }

      // Scroll to bottom on initial load
      setTimeout(() => {
        if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
      }, 100);
    } catch (err) {
      console.error("Failed to join room:", err);
      dispatch("toast", "Failed to join room");
    }
  }

  // Reactive: join when roomManager becomes available
  $: if ($roomManager && roomId && !unsubscribeManifest) {
    joinRoom();
  }

  async function handleDownload(file) {
    if (!$fs || downloading.has(file.cid)) return;

    downloading.add(file.cid);
    downloading = downloading;

    try {
      const blob = await fetchFileAsBlob($fs, file.cid, file.name);
      downloadFile(blob, file.name);
      dispatch("toast", `Downloaded ${file.name}`);
    } catch (err) {
      console.error("Download failed:", err);
      dispatch("toast", "Download failed");
    } finally {
      downloading.delete(file.cid);
      downloading = downloading;
    }
  }

  async function sendMessage() {
    if (!newMessage.trim() || !$roomManager) return;

    try {
      await $roomManager.sendChat(roomId, newMessage);
      newMessage = "";
      setTimeout(() => {
        if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
      }, 50);
    } catch (err) {
      console.error("Failed to send message:", err);
    }
  }

  async function openShareModal() {
    showShareModal = true;
    try {
      qrCodeUrl = await QRCode.toDataURL(inviteLink);
    } catch (err) {
      console.error("QR generation failed:", err);
    }
  }

  function copyInvite() {
    navigator.clipboard.writeText(inviteLink);
    dispatch("toast", "Link copied!");
  }

  function saveName() {
    if (!roomName.trim()) {
      roomName = roomId.slice(0, 8);
    }
    saveRoom({ id: roomId, roomId, name: roomName });
    editingName = false;
  }

  async function handleAddFiles(event) {
    const files = event.target?.files || event.dataTransfer?.files;
    if (!files || files.length === 0 || !$fs || !$roomManager) return;

    uploading = true;
    uploadProgress = { percent: 0, label: "Adding files..." };

    try {
      const newManifest = await addFilesAndCreateManifest(
        $fs,
        Array.from(files),
        (loaded, total) => {
          uploadProgress = {
            percent: Math.round((loaded / total) * 100),
            label: `${loaded} / ${total} files`,
          };
        }
      );

      // Merge with existing manifest
      const currentFiles = manifest.files || [];
      const allFiles = [...currentFiles, ...newManifest.files];
      const merged = { files: allFiles, updatedAt: Date.now() };

      await $roomManager.setManifest(roomId, merged);
      dispatch("toast", "Files added!");
    } catch (err) {
      console.error("Add files failed:", err);
      dispatch("toast", "Failed to add files");
    } finally {
      uploading = false;
      if (event.target) event.target.value = "";
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    handleAddFiles(event);
  }

  function handleDragOver(event) {
    event.preventDefault();
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + " " + sizes[i];
  }

  onDestroy(() => {
    if (unsubscribeManifest) unsubscribeManifest();
    if (unsubscribeChat) unsubscribeChat();
  });
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      {#if editingName}
        <input
          type="text"
          bind:value={roomName}
          on:blur={saveName}
          on:keydown={(e) => e.key === "Enter" && saveName()}
          class="text-xl font-semibold border-b-2 border-blue-500 outline-none bg-transparent"
          autofocus
        />
      {:else}
        <h1 class="text-xl font-semibold">{roomName}</h1>
        <button
          on:click={() => (editingName = true)}
          class="text-gray-400 hover:text-gray-600"
        >
          ✎
        </button>
      {/if}
    </div>

    <button
      on:click={openShareModal}
      class="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
    >
      Share
    </button>
  </div>

  <div class="bg-white border rounded p-4">
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
        id="add-files-input"
        on:change={handleAddFiles}
      />
      <p>
        Drag & drop files here, or
        <label for="add-files-input" class="underline cursor-pointer"
          >browse</label
        >
      </p>
    </div>
  </div>

  {#if uploading}
    <div class="bg-white border rounded p-4">
      <div class="text-sm text-gray-700">{uploadProgress.label}</div>
      <div class="w-full bg-gray-200 h-2 rounded mt-1">
        <div
          class="bg-blue-500 h-2 rounded"
          style="width: {uploadProgress.percent}%"
        ></div>
      </div>
    </div>
  {/if}

  <div class="bg-white border rounded p-4">
    <h2 class="font-semibold mb-3">Files ({manifest.files?.length || 0})</h2>
    {#if manifest.files && manifest.files.length > 0}
      <ul class="space-y-2">
        {#each manifest.files as file}
          <li
            class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-2 hover:bg-gray-50 rounded"
          >
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <div class="text-2xl flex-shrink-0">📄</div>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium truncate">{file.name}</div>
                <div class="text-xs text-gray-500">
                  {formatBytes(file.size)}
                </div>
              </div>
            </div>
            <div class="flex gap-2 sm:flex-shrink-0">
              <button
                on:click={() => handleDownload(file)}
                disabled={downloading.has(file.cid)}
                class="px-3 py-1.5 border rounded text-xs hover:bg-gray-100 disabled:bg-gray-200 whitespace-nowrap w-full sm:w-auto"
              >
                {downloading.has(file.cid) ? "Downloading..." : "Download"}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-gray-500">No files yet</p>
    {/if}
  </div>

  <!-- Chat Section -->
  <div class="bg-white border rounded p-4">
    <h2 class="font-semibold mb-3">Chat</h2>
    <div
      class="space-y-2 max-h-64 overflow-y-auto mb-3"
      bind:this={chatContainer}
      on:scroll={checkScroll}
    >
      {#each chatMessages as msg}
        <div class="text-sm">
          <span class="font-medium text-gray-700">{msg.from?.slice(0, 8)}:</span
          >
          <span class="text-gray-900">{msg.text}</span>
        </div>
      {/each}
    </div>
    <div class="flex gap-2">
      <input
        type="text"
        placeholder="Type a message..."
        class="flex-1 border rounded px-3 py-2 text-sm"
        bind:value={newMessage}
        on:keydown={(e) => e.key === "Enter" && sendMessage()}
      />
      <button
        on:click={sendMessage}
        class="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
      >
        Send
      </button>
    </div>
  </div>
</div>

<!-- Share Modal -->
{#if showShareModal}
  <div
    class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    on:click={() => (showShareModal = false)}
  >
    <div
      class="bg-white rounded-lg p-6 max-w-md w-full mx-4"
      on:click={(e) => e.stopPropagation()}
    >
      <h3 class="text-lg font-semibold mb-4">Share Room</h3>

      {#if qrCodeUrl}
        <div class="flex justify-center mb-4">
          <img src={qrCodeUrl} alt="QR Code" class="w-48 h-48" />
        </div>
      {/if}

      <div class="mb-4">
        <label class="text-sm text-gray-600 block mb-1">Invite link</label>
        <div class="flex gap-2">
          <input
            type="text"
            readonly
            value={inviteLink}
            class="flex-1 border rounded px-3 py-2 text-sm bg-gray-50"
          />
          <button
            on:click={copyInvite}
            class="px-3 py-2 border rounded text-sm hover:bg-gray-50"
          >
            Copy
          </button>
        </div>
      </div>

      <button
        on:click={() => (showShareModal = false)}
        class="w-full px-3 py-2 border rounded text-sm hover:bg-gray-50"
      >
        Close
      </button>
    </div>
  </div>
{/if}
