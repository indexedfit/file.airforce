// @ts-check
/**
 * File operations: upload, download, progress tracking
 * Extracted from bootstrap.js for clarity
 */

import { CID } from 'multiformats/cid'
import { decode as decodeDagPb } from '@ipld/dag-pb'

/**
 * Detect and unwrap dag-pb + UnixFS protobuf encoding from raw blocks
 *
 * BUG WORKAROUND: Some blocks arrive from bitswap with dag-pb wrapping even when
 * the CID codec indicates raw (0x55). This appears to be a Helia bitswap bug on
 * iOS Safari where remote blocks are re-encoded during transfer.
 *
 * Root cause: CID says "raw codec" but actual block bytes have dag-pb PBNode wrapper.
 * fs.cat() trusts the CID codec and doesn't unwrap, causing corrupt data.
 *
 * This function detects dag-pb signature (0x0a) and manually unwraps the PBNode.Data field.
 */
function unwrapDagPb(bytes) {
  try {
    // Check if bytes start with dag-pb signature (0x0a = field 1, wire type 2)
    if (bytes[0] === 0x0a) {
      console.log('[unwrapDagPb] ⚠️  Detected dag-pb wrapper on block with raw CID codec!')
      console.log('[unwrapDagPb] This is a Helia bitswap bug - CID codec says raw but block is wrapped')

      // Decode the dag-pb PBNode
      const node = decodeDagPb(bytes)

      // The actual file data is in node.Data
      if (node.Data) {
        console.log(`[unwrapDagPb] ✓ Unwrapped ${bytes.length} -> ${node.Data.length} bytes`)

        // Log first few bytes of unwrapped data
        const hex = Array.from(node.Data.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')
        console.log(`[unwrapDagPb] Unwrapped data starts with: ${hex}`)

        // Validate it's actual file data (common file signatures)
        const first = node.Data[0]
        const second = node.Data[1]
        const third = node.Data[2]

        // JPEG: ff d8 ff
        // PNG: 89 50 4e 47
        // GIF: 47 49 46 38
        // WebP: 52 49 46 46 (RIFF)
        const isValidFileData = (
          (first === 0xff && second === 0xd8 && third === 0xff) || // JPEG
          (first === 0x89 && second === 0x50 && third === 0x4e && node.Data[3] === 0x47) || // PNG
          (first === 0x47 && second === 0x49 && third === 0x46) || // GIF
          (first === 0x52 && second === 0x49 && third === 0x46 && node.Data[3] === 0x46) // WebP/RIFF
        )

        if (isValidFileData) {
          console.log('[unwrapDagPb] ✓ Valid file signature detected in unwrapped data')
          return node.Data
        } else {
          console.warn(`[unwrapDagPb] Unwrapped data doesn't have known file signature, keeping original`)
          console.warn(`[unwrapDagPb] First 3 bytes: 0x${first.toString(16)} 0x${second.toString(16)} 0x${third.toString(16)}`)
        }
      } else {
        console.warn('[unwrapDagPb] PBNode has no Data field')
      }
    }
  } catch (err) {
    console.warn('[unwrapDagPb] Failed to unwrap, using original bytes:', err.message)
  }
  return bytes
}

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
  console.log(`[fetchFileAsBlob] START - name="${name}", cid="${cid}"`);
  console.log(`[fetchFileAsBlob] CID type:`, typeof cid, cid.constructor?.name);

  // iOS Safari fix: Parse CID string to CID object
  // Helia expects CID objects, not strings, for reliable operation
  if (typeof cid === 'string') {
    console.log(`[fetchFileAsBlob] Converting string CID to CID object...`);
    try {
      cid = CID.parse(cid);
      console.log(`[fetchFileAsBlob] ✓ CID parsed:`, cid.toString());
      console.log(`[fetchFileAsBlob] CID codec: ${cid.code} (0x${cid.code.toString(16)}) - raw=0x55, dag-pb=0x70`);
    } catch (err) {
      console.error(`[fetchFileAsBlob] Failed to parse CID:`, err);
      throw new Error(`Invalid CID: ${cid}`);
    }
  }

  let total = 0;
  const parts = [];
  let loaded = 0;

  try {
    console.log(`[fetchFileAsBlob] Calling fs.cat() with CID object...`);
    for await (const chunk of fs.cat(cid)) {
      console.log(`[fetchFileAsBlob] Got chunk: type=${chunk.constructor.name}, length=${chunk.length || chunk.byteLength || 0}`);

      // iOS Safari fix: Ensure chunks are standard Uint8Arrays, not subclasses
      let standardChunk = chunk instanceof Uint8Array ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : chunk;

      // Critical fix: Unwrap dag-pb encoding if present
      // Bitswap blocks sometimes arrive with dag-pb wrapping that fs.cat() doesn't strip
      standardChunk = unwrapDagPb(standardChunk);

      parts.push(standardChunk);
      loaded += standardChunk.length || standardChunk.byteLength || 0;
      onProgress(loaded, total);
    }

    console.log(`[fetchFileAsBlob] All chunks received: total=${parts.length} chunks, ${loaded} bytes`);

    const mimeType = guessMime(name);
    console.log(`[fetchFileAsBlob] MIME type from name: "${mimeType}"`);

    // iOS Safari: Create blob with explicit type
    const blob = new Blob(parts, { type: mimeType });
    console.log(`[fetchFileAsBlob] ✓ Blob created: size=${blob.size}, type="${blob.type}", chunks=${parts.length}`);

    // Verify blob is valid
    if (blob.size === 0 && loaded > 0) {
      console.error(`[fetchFileAsBlob] ✗ Blob size is 0 but we loaded ${loaded} bytes! Blob creation failed`);
    }

    console.log(`[fetchFileAsBlob] Blob details:`, {
      size: blob.size,
      type: blob.type,
      name: name,
      cid: cid,
      expectedType: mimeType,
      matchesExpected: blob.type === mimeType,
      sizeMatchesLoaded: blob.size === loaded
    });

    return blob;
  } catch (err) {
    console.error(`[fetchFileAsBlob] ✗ ERROR fetching ${name}:`, err);
    throw err;
  }
}

/**
 * Fetch file with retry logic for iOS Safari protobuf errors
 * iOS Safari sometimes fails on first attempt but succeeds on retry
 * Uses same timing as thumbnail manager (500ms delay, 60 retries = 30s total)
 */
export async function fetchFileAsBlobWithRetry(fs, cid, name, onProgress = () => {}, maxRetries = 60) {
  let lastError = null;
  const RETRY_DELAY = 500; // Match thumbnail manager's POLL_INTERVAL

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetchFileAsBlob(fs, cid, name, onProgress);
    } catch (err) {
      lastError = err;
      const isProtobufError = err.message?.includes('protobuf') || err.message?.includes('wireType');

      if (isProtobufError && attempt < maxRetries - 1) {
        // Wait 500ms before retry (same as thumbnail manager)
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
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
