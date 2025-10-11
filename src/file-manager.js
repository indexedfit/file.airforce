// @ts-check
/**
 * File operations: upload, download, progress tracking
 * Extracted from bootstrap.js for clarity
 */

export function guessMime(name = "") {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const map = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
    md: "text/markdown",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    csv: "text/csv",
  };
  return map[ext] || "application/octet-stream";
}

export async function fetchFileAsBlob(fs, cid, name, onProgress = () => {}) {
  console.log(`[fetchFileAsBlob] Starting fetch for ${name} (${cid})`);
  let total = 0;
  const parts = [];
  let loaded = 0;
  try {
    for await (const chunk of fs.cat(cid)) {
      console.log(`[fetchFileAsBlob] Got chunk ${parts.length + 1}: ${chunk.length || chunk.byteLength} bytes, type: ${chunk.constructor.name}`);
      parts.push(chunk);
      loaded += chunk.length || chunk.byteLength || 0;
      onProgress(loaded, total);
    }
    console.log(`[fetchFileAsBlob] ✓ Fetched ${parts.length} chunks, ${loaded} bytes total`);

    // Log first few bytes to check if it's valid data
    if (parts.length > 0 && parts[0].length > 0) {
      const firstBytes = new Uint8Array(parts[0].slice(0, Math.min(20, parts[0].length)));
      console.log(`[fetchFileAsBlob] First bytes: ${Array.from(firstBytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }

    const blob = new Blob(parts, { type: guessMime(name) });
    console.log(`[fetchFileAsBlob] ✓ Created blob: ${blob.size} bytes, type: ${blob.type}`);
    return blob;
  } catch (err) {
    console.error(`[fetchFileAsBlob] ✗ Failed to fetch ${name}:`, err);
    throw new Error(`Failed to fetch file: ${err.message || 'Unknown error'}`);
  }
}

export async function addFilesAndCreateManifest(fs, files, onProgress = () => {}) {
  console.log(`[addFiles] Starting with ${files.length} files`);
  const manifest = { files: [], updatedAt: Date.now() };
  let done = 0;
  const total = files.length;

  for (const f of files) {
    console.log(`[addFiles] Processing file ${done + 1}/${total}: ${f.name} (${f.size} bytes)`);
    try {
      const data = new Uint8Array(await f.arrayBuffer());
      console.log(`[addFiles] Read ${data.length} bytes, adding to blockstore...`);
      const cid = await fs.addBytes(data);
      console.log(`[addFiles] Added with CID: ${cid.toString()}`);
      manifest.files.push({ name: f.name, size: f.size, cid: cid.toString() });
      done++;
      onProgress(done, total);
    } catch (err) {
      console.error(`[addFiles] Failed to add ${f.name}:`, err);
      throw err;
    }
  }

  console.log(`[addFiles] Completed, manifest has ${manifest.files.length} files`);
  return manifest;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function openFile(blob, name) {
  // Use in-app viewer for better mobile experience
  const { showFileViewer } = await import('./file-viewer.js');
  await showFileViewer(blob, name);
}

export function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
