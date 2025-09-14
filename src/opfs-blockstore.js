// Minimal browser Blockstore using OPFS with IDB fallback.
// Methods used by Helia: open, close (noop), get, put, has, delete, putMany/getMany (best effort).

const supportsOPFS = !!(navigator?.storage?.getDirectory)

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
  if (supportsOPFS) {
    const { blocks } = await createOPFSRoot(rootName)
    const api = {
      async open() {},
      async close() {},
      async put(cid, bytes) {
        const [a, b, name] = splitCid(cid)
        const dir = await ensurePath(blocks, [a, b])
        await writeFile(dir, `${name}.bin`, bytes)
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

  const db = await openIDB(rootName)
  const tx = (mode) => db.transaction('blocks', mode).objectStore('blocks')
  const api = {
    async open() {},
    async close() { db.close() },
    async put(cid, bytes) {
      await new Promise((res, rej) => {
        const req = tx('readwrite').put(bytes, cid.toString())
        req.onsuccess = () => res()
        req.onerror = () => rej(req.error)
      })
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

