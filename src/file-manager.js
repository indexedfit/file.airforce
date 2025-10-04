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

export async function addFilesAndCreateManifest(fs, files, onProgress = () => {}) {
  const manifest = { files: [], updatedAt: Date.now() };
  let done = 0;
  const total = files.length;

  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    const cid = await fs.addBytes(data);
    manifest.files.push({ name: f.name, size: f.size, cid: cid.toString() });
    done++;
    onProgress(done, total);
  }

  return manifest;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function openFile(blob, name) {
  // iOS Safari doesn't support blob URLs in window.open()
  // Convert to data URL instead
  const reader = new FileReader();
  reader.onload = () => {
    window.open(reader.result, "_blank");
  };
  reader.readAsDataURL(blob);
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
