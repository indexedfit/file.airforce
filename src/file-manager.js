// @ts-check
/**
 * File operations: upload, download, progress tracking
 * Extracted from bootstrap.js for clarity
 */

import { CID } from 'multiformats/cid'
import { decode as decodeDagPb } from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'

/**
 * Detect and unwrap dag-pb + UnixFS protobuf encoding from raw blocks
 *
 * BUG WORKAROUND: Some blocks arrive from bitswap with dag-pb wrapping even when
 * the CID codec indicates raw (0x55). This is a Helia bitswap bug where remote
 * blocks are stored with UnixFS metadata wrapping.
 *
 * Root cause: CID says "raw codec" but actual block bytes have dag-pb PBNode + UnixFS wrapper.
 * fs.cat() trusts the CID codec and doesn't unwrap, causing corrupt data.
 *
 * This function detects protobuf signature (0x0a) and manually unwraps to get raw file data.
 */
function unwrapDagPb(bytes) {
  try {
    // Check if bytes start with protobuf signature (0x0a = field 1, wire type 2)
    if (bytes[0] === 0x0a) {
      console.log('[unwrapDagPb] ⚠️  Detected protobuf wrapper on block with raw CID codec!')

      // Dump first 100 bytes to analyze the structure
      const dumpLen = Math.min(100, bytes.length)
      const hexDump = Array.from(bytes.slice(0, dumpLen)).map(b => b.toString(16).padStart(2, '0')).join(' ')
      console.log(`[unwrapDagPb] First ${dumpLen} bytes:`, hexDump)

      // Look for PNG signature in the data
      for (let i = 0; i < Math.min(200, bytes.length - 8); i++) {
        if (bytes[i] === 0x89 && bytes[i+1] === 0x50 && bytes[i+2] === 0x4e && bytes[i+3] === 0x47) {
          console.log(`[unwrapDagPb] ✓ Found PNG signature at offset ${i}`)
          const extracted = bytes.slice(i)
          console.log(`[unwrapDagPb] ✓ Extracted ${extracted.length} bytes from offset ${i}`)
          return extracted
        }
        if (bytes[i] === 0xff && bytes[i+1] === 0xd8 && bytes[i+2] === 0xff) {
          console.log(`[unwrapDagPb] ✓ Found JPEG signature at offset ${i}`)
          const extracted = bytes.slice(i)
          console.log(`[unwrapDagPb] ✓ Extracted ${extracted.length} bytes from offset ${i}`)
          return extracted
        }
      }

      // First try: dag-pb PBNode decoding
      try {
        const node = decodeDagPb(bytes)
        if (node.Data) {
          console.log(`[unwrapDagPb] dag-pb unwrap: ${bytes.length} -> ${node.Data.length} bytes`)

          // Try to unwrap UnixFS from PBNode.Data
          try {
            const unixfs = UnixFS.unmarshal(node.Data)
            if (unixfs.data) {
              console.log(`[unwrapDagPb] ✓ UnixFS unwrap: ${node.Data.length} -> ${unixfs.data.length} bytes`)
              return unixfs.data
            }
          } catch (unixfsErr) {
            console.log(`[unwrapDagPb] No UnixFS layer, using PBNode.Data directly`)
            return node.Data
          }
        }
      } catch (pbErr) {
        console.log(`[unwrapDagPb] Not valid dag-pb: ${pbErr.message}`)
      }

      // Second try: Direct UnixFS unwrapping (no outer PBNode)
      try {
        const unixfs = UnixFS.unmarshal(bytes)
        if (unixfs.data) {
          console.log(`[unwrapDagPb] ✓ Direct UnixFS unwrap: ${bytes.length} -> ${unixfs.data.length} bytes`)
          return unixfs.data
        }
      } catch (unixfsErr) {
        console.warn(`[unwrapDagPb] Direct UnixFS failed: ${unixfsErr.message}`)
      }

      console.warn('[unwrapDagPb] All unwrap methods failed, returning original bytes')
    }
  } catch (err) {
    console.warn('[unwrapDagPb] Unwrap failed, using original bytes:', err.message)
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
