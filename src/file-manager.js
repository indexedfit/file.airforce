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

export function openFile(blob, name) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (isIOS || isSafari) {
    // Safari/iOS: Pre-open window synchronously to avoid popup blocker
    const win = window.open("", "_blank");
    if (!win) {
      console.warn('Popup blocked');
      return;
    }

    // Show loading state
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Loading...</title>
        <style>
          body { margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; }
          iframe { border: 0; width: 100vw; height: 100vh; position: absolute; top: 0; left: 0; }
        </style>
      </head>
      <body>
        <div>Loading ${name}...</div>
      </body>
      </html>
    `);
    win.document.close();

    // Convert to data URL and update window content
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result;
      win.document.body.innerHTML = `<iframe src="${dataUrl}"></iframe>`;
    };
    reader.onerror = () => {
      win.document.body.innerHTML = '<div>Failed to load file</div>';
    };
    reader.readAsDataURL(blob);
  } else {
    // Standard approach for desktop browsers
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
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
