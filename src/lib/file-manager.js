// @ts-check
import { CID } from 'multiformats/cid'

export function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function fetchFileAsBlob(fs, cidStr, name) {
  const cid = CID.parse(cidStr)
  const chunks = []
  for await (const chunk of fs.cat(cid)) {
    chunks.push(chunk)
  }
  return new Blob(chunks)
}

export async function addFilesAndCreateManifest(fs, files, onProgress = () => {}) {
  const manifest = { files: [], updatedAt: Date.now() }
  let done = 0
  const total = files.length

  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer())
    const cid = await fs.addBytes(data)
    manifest.files.push({ name: f.name, size: f.size, cid: cid.toString() })
    done++
    onProgress(done, total)
  }

  return manifest
}
