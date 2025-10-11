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
  let total = 0;
  const parts = [];
  let loaded = 0;
  for await (const chunk of fs.cat(cid)) {
    parts.push(chunk);
    loaded += chunk.length || chunk.byteLength || 0;
    onProgress(loaded, total);
  }
  return new Blob(parts, { type: guessMime(name) });
}

/**
 * Fetch file with retry logic for iOS Safari protobuf errors
 * iOS Safari sometimes fails on first attempt but succeeds on retry
 */
export async function fetchFileAsBlobWithRetry(fs, cid, name, onProgress = () => {}, maxRetries = 10) {
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetchFileAsBlob(fs, cid, name, onProgress);
    } catch (err) {
      lastError = err;
      const isProtobufError = err.message?.includes('protobuf') || err.message?.includes('wireType');

      if (isProtobufError && attempt < maxRetries - 1) {
        // Wait briefly before retry (exponential backoff)
        const delay = Math.min(100 * Math.pow(1.5, attempt), 1000);
        await new Promise(resolve => setTimeout(resolve, delay));
        console.log(`[fetchFile] Retry ${attempt + 1}/${maxRetries} for ${name}...`);
        continue;
      }

      // Not a protobuf error or out of retries
      throw err;
    }
  }

  throw lastError;
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
