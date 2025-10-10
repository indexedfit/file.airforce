// @ts-check
import { createLibp2p } from 'libp2p'
import { createHelia } from 'helia'
import { unixfs } from '@helia/unixfs'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp'
import { FsBlockstore } from 'blockstore-fs'
import { LevelDatastore } from 'datastore-level'
import { CID } from 'multiformats/cid'
import { createServer } from 'http'
import { PUBSUB_PEER_DISCOVERY } from '../src/constants.js'

async function main() {
  const WS_PORT = process.env.WS_PORT || 9005
  const TCP_PORT = process.env.TCP_PORT || 9006
  const HTTP_PORT = process.env.HTTP_PORT || 9007

  const blockstore = new FsBlockstore('./data/mirror-blocks')
  const datastore = new LevelDatastore('./data/mirror-datastore')

  await datastore.open()

  const libp2p = await createLibp2p({
    addresses: {
      listen: [
        `/ip4/0.0.0.0/tcp/${WS_PORT}/ws`,
        `/ip4/0.0.0.0/tcp/${TCP_PORT}`
      ],
    },
    transports: [webSockets(), tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      maxConnections: 200,
      minConnections: 0,
      inboundConnectionThreshold: 100,
    },
    services: {
      identify: identify(),
      pubsub: gossipsub(),
    },
    datastore,
  })

  const helia = await createHelia({ libp2p, blockstore, datastore })
  const fs = unixfs(helia)

  libp2p.services.pubsub.subscribe(PUBSUB_PEER_DISCOVERY)

  console.log('Mirror PeerID:', libp2p.peerId.toString())
  console.log('WS Port:', WS_PORT, '| TCP Port:', TCP_PORT, '| HTTP Port:', HTTP_PORT)
  console.log('Multiaddrs:', libp2p.getMultiaddrs())

  libp2p.addEventListener('peer:connect', (evt) => {
    const peerId = evt.detail.toString()
    console.log(`[Connect] ${peerId.slice(-16)}`)
  })

  libp2p.addEventListener('peer:disconnect', (evt) => {
    const peerId = evt.detail.toString()
    console.log(`[Disconnect] ${peerId.slice(-16)}`)
  })

  // HTTP API for uploading blocks directly
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'POST' && req.url === '/upload') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks)
          const { blocks } = JSON.parse(body.toString())

          if (!Array.isArray(blocks) || blocks.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'blocks array required' }))
            return
          }

          const stored = []
          const failed = []

          for (const { cid, bytes } of blocks) {
            try {
              const cidObj = CID.parse(cid)
              const data = Uint8Array.from(Buffer.from(bytes, 'base64'))
              await blockstore.put(cidObj, data)
              await helia.pins.add(cidObj)
              stored.push(cid)
              console.log(`[Stored] ${cid}`)
            } catch (err) {
              console.error(`[Store Error] ${cid}:`, err.message)
              failed.push({ cid, error: err.message })
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ stored, failed }))
        } catch (err) {
          console.error('[API Error]', err)
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`HTTP API listening on port ${HTTP_PORT}`)
  })

  setInterval(() => {
    const conns = libp2p.getConnections()
    const peers = libp2p.getPeers()
    console.log(`[Mirror Stats] ${conns.length} conns, ${peers.length} peers`)
  }, 30000)
}

main()
