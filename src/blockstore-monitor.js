// @ts-check
/**
 * Blockstore wrapper that monitors get/put operations for progress tracking
 * Emits events when blocks are fetched from bitswap
 */

export class BlockstoreMonitor {
  constructor(blockstore) {
    this.blockstore = blockstore
    this.listeners = new Set()
    this.stats = {
      blocksReceived: 0,
      blocksSent: 0,
      bytesReceived: 0,
      bytesSent: 0
    }
  }

  on(event, listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event, data) {
    for (const listener of this.listeners) {
      try {
        listener(event, data)
      } catch {}
    }
  }

  async get(cid, options) {
    const start = Date.now()
    try {
      const block = await this.blockstore.get(cid, options)
      const size = block?.byteLength || block?.length || 0
      this.stats.blocksReceived++
      this.stats.bytesReceived += size
      this.emit('block:get', {
        cid: cid.toString(),
        size,
        duration: Date.now() - start,
        stats: { ...this.stats }
      })
      return block
    } catch (err) {
      this.emit('block:get:error', {
        cid: cid.toString(),
        error: err.message
      })
      throw err
    }
  }

  async put(cid, block, options) {
    const size = block?.byteLength || block?.length || 0
    try {
      const result = await this.blockstore.put(cid, block, options)
      this.stats.blocksSent++
      this.stats.bytesSent += size
      this.emit('block:put', {
        cid: cid.toString(),
        size,
        stats: { ...this.stats }
      })
      return result
    } catch (err) {
      this.emit('block:put:error', {
        cid: cid.toString(),
        error: err.message
      })
      throw err
    }
  }

  async has(cid, options) {
    return this.blockstore.has(cid, options)
  }

  async delete(cid, options) {
    return this.blockstore.delete(cid, options)
  }

  async *getMany(cids, options) {
    for (const cid of cids) {
      yield { cid, block: await this.get(cid, options) }
    }
  }

  async *putMany(blocks, options) {
    for await (const { cid, block } of blocks) {
      await this.put(cid, block, options)
      yield { cid, block }
    }
  }

  async *deleteMany(cids, options) {
    for await (const cid of cids) {
      await this.delete(cid, options)
      yield cid
    }
  }

  async *getAll(options) {
    yield* this.blockstore.getAll(options)
  }

  resetStats() {
    this.stats = {
      blocksReceived: 0,
      blocksSent: 0,
      bytesReceived: 0,
      bytesSent: 0
    }
  }
}
