// Minimal browser Blockstore using OPFS with IDB fallback.
// Methods used by Helia: open, close (noop), get, put, has, delete, putMany/getMany (best effort).

import { supportsOPFS } from './opfs-utils.js'
import { decode as decodeDagPb } from '@ipld/dag-pb'
import { UnixFS } from 'ipfs-unixfs'

async function createOPFSRoot(rootName = 'wc-blocks') {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(rootName, { create: true })
  const blocks = await dir.getDirectoryHandle('blocks', { create: true })
  return { dir, blocks }
}

async function ensurePath(dirHandle, segments) {
  let current = dirHandle
  for (const seg of segments) {
    current = await current.getDirectoryHandle(seg, { create: true })
  }
  return current
}

async function writeFile(dirHandle, name, bytes) {
  const fh = await dirHandle.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(bytes)
  await w.close()
}

async function readFile(dirHandle, name) {
  const fh = await dirHandle.getFileHandle(name, { create: false })
  const file = await fh.getFile()
  return new Uint8Array(await file.arrayBuffer())
}

async function deleteFile(dirHandle, name) {
  await dirHandle.removeEntry(name, { recursive: false })
}

function splitCid(cidStr) {
  const s = cidStr.toString()
  return [s.slice(0, 2), s.slice(2, 4), s]
}

/**
 * Fix codec mismatch: unwrap dag-pb/UnixFS encoding when CID indicates raw codec
 * This prevents storing malformed blocks that break fs.cat() on retrieval
 */
function unwrapIfNeeded(bytes, cidStr) {
  const isRawCodec = cidStr.startsWith('bafkrei')  // raw codec (0x55)
  const hasDagPbSig = bytes[0] === 0x0a  // dag-pb signature

  if (!isRawCodec || !hasDagPbSig) {
    return bytes  // No mismatch, return as-is
  }

  console.log(`[Blockstore] Unwrapping malformed block ${cidStr.slice(0, 20)}...`)

  try {
    // Try dag-pb PBNode decoding
    const node = decodeDagPb(bytes)
    if (node.Data) {
      // Try to unwrap UnixFS from PBNode.Data
      try {
        const unixfs = UnixFS.unmarshal(node.Data)
        if (unixfs.data) {
          console.log(`[Blockstore] ✓ Unwrapped: ${bytes.length} -> ${unixfs.data.length} bytes (dag-pb + UnixFS)`)
          return unixfs.data
        }
      } catch {
        // No UnixFS layer, use PBNode.Data directly
        console.log(`[Blockstore] ✓ Unwrapped: ${bytes.length} -> ${node.Data.length} bytes (dag-pb only)`)
        return node.Data
      }
    }
  } catch (err) {
    console.warn(`[Blockstore] Failed to unwrap malformed block:`, err.message)
  }

  return bytes  // Unwrap failed, store as-is (download workaround will handle it)
}

function openIDB(name = 'wc-blocks') {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks')
    }
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
  })
}

export async function createOPFSBlockstore(rootName = 'wc-blocks') {
  if (supportsOPFS()) {
    console.log('[Blockstore] Using OPFS');
    const { blocks } = await createOPFSRoot(rootName)
    const api = {
      async open() {},
      async close() {},
      async put(cid, bytes) {
        const cidStr = cid.toString()

        // Debug: Check for codec/encoding mismatch BEFORE unwrapping
        const isRawCodec = cidStr.startsWith('bafkrei')  // raw codec
        const hasDagPbSig = bytes[0] === 0x0a  // dag-pb signature

        if (isRawCodec && hasDagPbSig) {
          console.group(`[Blockstore OPFS] ⚠️  CODEC MISMATCH DETECTED`);
          console.warn(`CID: ${cidStr} (raw codec 0x55)`);
          console.warn(`Block starts with 0x0a (dag-pb signature)`);
          console.warn(`Block size: ${bytes.length} bytes`);
          console.warn(`First 32 bytes:`, Array.from(bytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));

          // Try to identify call path
          const stack = new Error().stack;
          const isBitswap = stack?.includes('bitswap') || stack?.includes('Bitswap');
          const isAddBytes = stack?.includes('addBytes');
          const isUnixFS = stack?.includes('unixfs') || stack?.includes('UnixFS');

          console.warn(`Call path hints:`, {
            likelyBitswap: isBitswap,
            likelyLocalUpload: isAddBytes || isUnixFS,
            source: isBitswap ? 'REMOTE (bitswap receive)' : isAddBytes ? 'LOCAL (fs.addBytes)' : 'UNKNOWN'
          });

          console.trace('Full call stack:');
          console.groupEnd();
        }

        // FIX: Unwrap malformed blocks before storing
        const unwrappedBytes = unwrapIfNeeded(bytes, cidStr)

        const [a, b, name] = splitCid(cid)
        const dir = await ensurePath(blocks, [a, b])
        await writeFile(dir, `${name}.bin`, unwrappedBytes)
        try { globalThis.wcOnBlockPut?.({ cid: cid.toString(), size: unwrappedBytes?.length || 0 }) } catch {}
        return cid
      },
      async get(cid) {
        const [a, b, name] = splitCid(cid)
        const dir = await ensurePath(blocks, [a, b])
        return await readFile(dir, `${name}.bin`)
      },
      async has(cid) {
        try {
          await api.get(cid)
          return true
        } catch {
          return false
        }
      },
      async delete(cid) {
        const [a, b, name] = splitCid(cid)
        const dir = await ensurePath(blocks, [a, b])
        await deleteFile(dir, `${name}.bin`)
      },
      async *putMany(source) {
        for await (const { cid, bytes } of source) {
          await api.put(cid, bytes)
          yield { cid, bytes }
        }
      },
      async *getMany(source) {
        for await (const cid of source) {
          yield { cid, bytes: await api.get(cid) }
        }
      }
    }
    return api
  }

  console.log('[Blockstore] Falling back to IndexedDB');
  const db = await openIDB(rootName)
  console.log('[Blockstore] IndexedDB opened successfully');
  const tx = (mode) => db.transaction('blocks', mode).objectStore('blocks')
  const api = {
    async open() {},
    async close() { db.close() },
    async put(cid, bytes) {
      const cidStr = cid.toString()

      // Debug: Check for codec/encoding mismatch BEFORE unwrapping
      const isRawCodec = cidStr.startsWith('bafkrei')  // raw codec
      const hasDagPbSig = bytes[0] === 0x0a  // dag-pb signature

      if (isRawCodec && hasDagPbSig) {
        console.group(`[Blockstore IDB] ⚠️  CODEC MISMATCH DETECTED`);
        console.warn(`CID: ${cidStr} (raw codec 0x55)`);
        console.warn(`Block starts with 0x0a (dag-pb signature)`);
        console.warn(`Block size: ${bytes.length} bytes`);
        console.warn(`First 32 bytes:`, Array.from(bytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));

        // Try to identify call path
        const stack = new Error().stack;
        const isBitswap = stack?.includes('bitswap') || stack?.includes('Bitswap');
        const isAddBytes = stack?.includes('addBytes');
        const isUnixFS = stack?.includes('unixfs') || stack?.includes('UnixFS');

        console.warn(`Call path hints:`, {
          likelyBitswap: isBitswap,
          likelyLocalUpload: isAddBytes || isUnixFS,
          source: isBitswap ? 'REMOTE (bitswap receive)' : isAddBytes ? 'LOCAL (fs.addBytes)' : 'UNKNOWN'
        });

        console.trace('Full call stack:');
        console.groupEnd();
      }

      // FIX: Unwrap malformed blocks before storing
      const unwrappedBytes = unwrapIfNeeded(bytes, cidStr)

      await new Promise((res, rej) => {
        const req = tx('readwrite').put(unwrappedBytes, cid.toString())
        req.onsuccess = () => res()
        req.onerror = () => rej(req.error)
      })
      try { globalThis.wcOnBlockPut?.({ cid: cid.toString(), size: unwrappedBytes?.length || 0 }) } catch {}
      return cid
    },
    async get(cid) {
      return await new Promise((res, rej) => {
        const req = tx('readonly').get(cid.toString())
        req.onsuccess = () => {
          if (!req.result) rej(new Error('NotFound'))
          else res(new Uint8Array(req.result))
        }
        req.onerror = () => rej(req.error)
      })
    },
    async has(cid) {
      return await new Promise((res) => {
        const req = tx('readonly').getKey(cid.toString())
        req.onsuccess = () => res(!!req.result)
        req.onerror = () => res(false)
      })
    },
    async delete(cid) {
      await new Promise((res, rej) => {
        const req = tx('readwrite').delete(cid.toString())
        req.onsuccess = () => res()
        req.onerror = () => rej(req.error)
      })
    },
    async *putMany(source) {
      for await (const { cid, bytes } of source) {
        await api.put(cid, bytes)
        yield { cid, bytes }
      }
    },
    async *getMany(source) {
      for await (const cid of source) {
        yield { cid, bytes: await api.get(cid) }
      }
    }
  }
  return api
}
