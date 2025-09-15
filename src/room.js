// @ts-check
import { ROOM_TOPIC } from "./constants.js";
import { saveRoom, updateRoomLastSeen } from "./store.js";

function enc(obj) {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function dec(buf) {
  return JSON.parse(new TextDecoder().decode(buf));
}

/**
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {number=} size
 * @property {string} cid
 *
 * @typedef {Object} Manifest
 * @property {FileEntry[]} files
 * @property {number=} seq
 * @property {number=} updatedAt
 *
 * @typedef {'HELLO'|'MANIFEST'|'REQUEST'|'ACK'|'CHAT'} RoomMsgType
 *
 * @typedef {Object} RoomMessage
 * @property {RoomMsgType} type
 * @property {string} roomId
 * @property {string=} from
 * @property {string=} text
 * @property {string[]=} fileCids
 * @property {Manifest=} manifest
 * @property {number=} ts
 * @property {number=} ttl // rebroadcast budget (decremented on forward)
 * @property {string=} msgId // dedupe id
 */

export function createRoomManager(helia, fs) {
  const libp2p = helia?.libp2p;

  // Fallback pubsub for fake/dev mode (BroadcastChannel per topic)
  const bcMap = new Map(); // topic -> BroadcastChannel

  // roomId -> { handler: fn, count: number }
  const topicHandlers = new Map();
  // roomId -> Set<fn>
  const subs = new Map();

  // --------- tiny per-topic outbox with exponential backoff ----------
  // topic -> { queue: any[], attempts: number, timer: any }
  const outbox = new Map();
  const MAX_BACKOFF_MS = 8000;
  const BASE_MS = 250;

  // message de-dup (recent msgIds)
  const seenMsg = new Map(); // topic -> LRU Set<string>
  const SEEN_LIMIT = 400;
  const rememberSeen = (topic, id) => {
    let s = seenMsg.get(topic);
    if (!s) {
      s = new Set();
      seenMsg.set(topic, s);
    }
    s.add(id);
    if (s.size > SEEN_LIMIT) {
      // approx LRU by dropping the first N (iteration order in Set is insertion)
      const drop = Math.floor(SEEN_LIMIT / 4);
      let n = 0;
      for (const v of s) {
        s.delete(v);
        if (++n >= drop) break;
      }
    }
  };
  const isSeen = (topic, id) => {
    const s = seenMsg.get(topic);
    return s ? s.has(id) : false;
  };

  const getSubsFor = (topic) => {
    try {
      return libp2p?.services?.pubsub?.getSubscribers?.(topic) ?? [];
    } catch {
      return [];
    }
  };

  function scheduleFlush(topic) {
    const entry = outbox.get(topic);
    if (!entry || entry.timer) return;
    const delay =
      Math.min(BASE_MS * Math.pow(2, entry.attempts || 0), MAX_BACKOFF_MS) +
      Math.floor(Math.random() * 200);
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      const hasSubs = getSubsFor(topic).length > 0;
      if (!hasSubs) {
        entry.attempts = Math.min((entry.attempts || 0) + 1, 8);
        scheduleFlush(topic);
        return;
      }
      // Flush all queued messages in order
      while (entry.queue.length) {
        const msg = entry.queue.shift();
        try {
          await libp2p.services.pubsub.publish(topic, enc(msg));
        } catch {
          // put it back and retry later
          entry.queue.unshift(msg);
          entry.attempts = Math.min((entry.attempts || 0) + 1, 8);
          break;
        }
      }
      if (entry.queue.length) scheduleFlush(topic);
      else entry.attempts = 0;
    }, delay);
  }

  // Nudge the outbox whenever new peers connect.
  if (libp2p?.addEventListener) {
    libp2p.addEventListener("peer:connect", () => {
      for (const topic of outbox.keys()) scheduleFlush(topic);
    });
  }

  async function waitForSubs(topic, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const s = libp2p?.services?.pubsub?.getSubscribers?.(topic) || [];
        if (s.length > 0) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }

  /**
   * Publish with msgId/ttl defaults. If there are no subs yet, enqueue.
   * @param {string} roomId
   * @param {RoomMessage} msg
   */
  async function publish(roomId, msg) {
    const topic = ROOM_TOPIC(roomId);
    // normalize metadata
    if (!msg.msgId) {
      msg.msgId =
        (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)) +
        "-" +
        Date.now().toString(36);
    }
    if (typeof msg.ttl !== "number") {
      // By default make core control messages noisy (1 forward hop).
      msg.ttl =
        msg.type === "HELLO" || msg.type === "MANIFEST" || msg.type === "CHAT"
          ? 1
          : 0;
    }
    if (libp2p?.services?.pubsub) {
      // If no known subscribers yet, enqueue + backoff instead of dropping.
      const hasSubs = getSubsFor(topic).length > 0;
      if (!hasSubs) {
        let entry = outbox.get(topic);
        if (!entry) {
          entry = { queue: [], attempts: 0, timer: null };
          outbox.set(topic, entry);
        }
        entry.queue.push(msg);
        scheduleFlush(topic);
        return;
      }
      // We have subs: just publish.
      await libp2p.services.pubsub.publish(topic, enc(msg));
    } else {
      let bc = bcMap.get(topic);
      if (!bc) {
        bc = new BroadcastChannel(topic);
        bcMap.set(topic, bc);
      }
      bc.postMessage(enc(msg));
    }
  }

  function ensureTopicListener(roomId) {
    if (topicHandlers.has(roomId)) return;
    const topic = ROOM_TOPIC(roomId);
    if (libp2p?.services?.pubsub) {
      /** @param {CustomEvent} evt */
      const handler = (evt) => {
        if (evt.detail.topic !== topic) return;
        const fns = subs.get(roomId);
        if (!fns?.size) return;
        try {
          /** @type {RoomMessage} */
          const m = dec(evt.detail.data);
          if (!m?.msgId) return;
          if (isSeen(topic, m.msgId)) return;
          rememberSeen(topic, m.msgId);
          // opportunistic one-hop forward (noisy sync)
          if ((m.ttl ?? 0) > 0) {
            const fwd = { ...m, ttl: (m.ttl ?? 0) - 1 };
            // tiny jitter to avoid lockstep
            setTimeout(() => publish(roomId, fwd).catch(() => {}), 50 + Math.floor(Math.random() * 120));
          }
          for (const fn of fns) fn(m, evt.detail);
        } catch {}
      };
      libp2p.services.pubsub.subscribe(topic);
      libp2p.services.pubsub.addEventListener("message", handler);
      topicHandlers.set(roomId, { handler, count: 0 });
    } else {
      let bc = bcMap.get(topic);
      if (!bc) {
        bc = new BroadcastChannel(topic);
        bcMap.set(topic, bc);
      }
      const handler = (ev) => {
        const fns = subs.get(roomId);
        if (!fns?.size) return;
        try {
          /** @type {RoomMessage} */
          const m = dec(ev.data);
          for (const fn of fns) fn(m, { from: "local" });
        } catch {}
      };
      bc.addEventListener("message", handler);
      topicHandlers.set(roomId, { handler, count: 0 });
    }
  }

  function subscribe(roomId, onMessage) {
    ensureTopicListener(roomId);
    let set = subs.get(roomId);
    if (!set) {
      set = new Set();
      subs.set(roomId, set);
    }
    set.add(onMessage);
    const t = topicHandlers.get(roomId);
    if (t) t.count++;
    return () => unsubscribe(roomId, onMessage);
  }

  function unsubscribe(roomId, fn) {
    const topic = ROOM_TOPIC(roomId);
    const set = subs.get(roomId);
    if (set) {
      if (fn) set.delete(fn);
      else set.clear();
      if (set.size === 0) {
        subs.delete(roomId);
        const th = topicHandlers.get(roomId);
        if (th) {
          if (libp2p?.services?.pubsub) {
            libp2p.services.pubsub.removeEventListener("message", th.handler);
            libp2p.services.pubsub.unsubscribe(topic);
          } else {
            const bc = bcMap.get(topic);
            bc?.removeEventListener("message", th.handler);
          }
          topicHandlers.delete(roomId);
        }
      }
    }
  }

  async function sendHello(roomId) {
    await publish(roomId, {
      type: "HELLO",
      roomId,
      from: libp2p.peerId.toString(),
      ttl: 1,
    });
  }

  async function sendManifest(roomId, manifest) {
    await publish(roomId, { type: "MANIFEST", roomId, manifest, ttl: 1 });
  }

  async function requestFiles(roomId, fileCids) {
    await publish(roomId, {
      type: "REQUEST",
      roomId,
      fileCids,
      from: libp2p.peerId.toString(),
      ttl: 0, // don't fan this out
    });
  }

  async function sendAck(roomId, info) {
    await publish(roomId, { type: "ACK", roomId, info });
  }

  async function sendChat(roomId, text) {
    const from = libp2p?.peerId?.toString?.() || "anon";
    // Fire-and-forget; outbox/backoff handles delivery
    publish(roomId, { type: "CHAT", roomId, text, from, ts: Date.now(), ttl: 1 }).catch(() => {});
  }

  // If invite included ?host= and ?tracker=, dial the host immediately via the tracker relay.
  async function tryDialHostFromInvite() {
    try {
      if (!libp2p?.dial) return;
      const sp = new URLSearchParams(globalThis.location?.search || "");
      const host = sp.get("host");
      const tr = sp.get("tracker");
      if (!host || !tr) return;
      const base = decodeURIComponent(tr); // ends with /p2p/<relayPeerId>
      const ma = `${base}/p2p-circuit/p2p/${host}`;
      await libp2p.dial(ma);
    } catch {}
  }

  function attachHost(room) {
    const { id: roomId, manifest } = room;
    subscribe(roomId, async (msg) => {
      updateRoomLastSeen(roomId);
      switch (msg.type) {
        case "HELLO":
          await sendManifest(roomId, manifest);
          break;
        case "REQUEST":
          for (const cidStr of msg.fileCids) {
            try {
              for await (const _ of helia.pin.add(cidStr)) {
              }
            } catch {}
          }
          await sendAck(roomId, { ok: true, pinned: msg.fileCids.length });
          break;
        case "MANIFEST":
          // peers may rehost and announce updates; persist
          if (msg.manifest) saveRoom({ id: roomId, manifest: msg.manifest });
          break;
      }
    });
    // Proactively (re)announce manifest a few times to beat mesh race.
    let bursts = 0;
    const t = setInterval(() => {
      bursts++;
      sendManifest(roomId, manifest).catch(() => {});
      if (bursts >= 5) clearInterval(t);
    }, 600 + Math.floor(Math.random() * 250));
  }

  function attachJoin(roomId, onManifest) {
    // Be aggressive: connect to the host right away using the relay in the invite.
    tryDialHostFromInvite().catch(() => {});
    let gotManifest = false;
    subscribe(roomId, async (msg) => {
      updateRoomLastSeen(roomId);
      if (msg.type === "MANIFEST" && msg.manifest) {
        gotManifest = true;
        // persist and bubble to UI
        saveRoom({ id: roomId, manifest: msg.manifest });
        onManifest(msg.manifest);
        // Auto-request + mirror all files immediately so CIDs start flowing.
        const cids = (msg.manifest.files || [])
          .map((f) => f.cid)
          .filter(Boolean);
        if (cids.length) {
          requestFiles(roomId, cids).catch(() => {});
          for (const cid of cids) {
            try {
              for await (const _ of helia.pin.add(cid)) {
              }
            } catch {}
          }
        }
      }
    });
    // Retry HELLO with backoff until we see a MANIFEST (bounded).
    let attempts = 0;
    const helloTick = async () => {
      if (gotManifest || attempts >= 8) return;
      attempts++;
      sendHello(roomId).catch(() => {});
      const delay = Math.min(400 * Math.pow(1.6, attempts), 5000);
      setTimeout(helloTick, delay);
    };
    helloTick();
  }

  return {
    publish,
    subscribe,
    unsubscribe,
    sendHello,
    sendManifest,
    requestFiles,
    sendAck,
    sendChat,
    attachHost,
    attachJoin,
  };
}
