/**
 * Thin PeerJS wrapper for a host-as-hub topology.
 * - The host owns a well-known peer id derived from the room code.
 * - Every player connects directly to the host; the host relays game state.
 * Uses the free public PeerJS broker for signaling only; game data is P2P.
 */

const NS = 'doodletel-k3'; // namespace prefix to avoid id clashes with other apps
export const peerIdForCode = (code) => `${NS}-${code.toLowerCase()}`;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
export function randomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

const REJOIN_WINDOW_MS = 45000;
const JOIN_TRY_MS = 18000;
const CONNECT_HANG_MS = 4000;
const HEARTBEAT_MS = 8000;

const CONN_OPTS = { reliable: true, serialization: 'json' };

const PEER_OPTS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'turn:0.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
    ],
    sdpSemantics: 'unified-plan',
    sdpSemantics: 'unified-plan',
  },
};

function makePeer(id) {
  return id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
}

function isControl(data) {
  return data && typeof data === 'object' && (data.t === '_ping' || data.t === '_pong');
}

function sendWhenOpen(conn, msg) {
  if (!conn) return;
  let sent = false;
  const go = () => {
    if (sent || !conn.open) return;
    sent = true;
    try { conn.send(msg); } catch {}
  };
  conn.once('open', go);
  go();
}

function startHeartbeat(conn) {
  const id = setInterval(() => {
    if (!conn.open) { clearInterval(id); return; }
    try { conn.send({ t: '_ping' }); } catch {}
  }, HEARTBEAT_MS);
  return () => clearInterval(id);
}

/**
 * PeerJS drops its signaling socket at the first excuse — a locked phone, a wifi
 * hiccup — and never goes back on its own. Open data channels survive, so a game
 * in progress looks healthy, but the peer id stops resolving: a host keeps
 * showing a room code that nobody can join any more. So nudge it back up.
 */
function keepSignalingAlive(peer, onStatus) {
  let timer = null;
  let delay = 1000;

  const attempt = () => {
    timer = null;
    if (peer.destroyed || !peer.disconnected) return;
    try { peer.reconnect(); } catch {}
    delay = Math.min(delay * 2, 15000);
    timer = setTimeout(attempt, delay);
  };

  const schedule = (ms) => {
    if (timer || peer.destroyed || !peer.disconnected) return;
    timer = setTimeout(attempt, ms ?? delay);
  };

  // Coming back from a locked screen or a dead tunnel: retry now, not in 15s.
  const wake = () => {
    if (document.hidden || peer.destroyed || !peer.disconnected) return;
    clearTimeout(timer); timer = null; delay = 1000;
    schedule(0);
  };

  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    onStatus?.('reconnecting');
    delay = 1000;
    schedule();
  });
  peer.on('open', () => {
    clearTimeout(timer); timer = null; delay = 1000;
    onStatus?.('online');
  });

  document.addEventListener('visibilitychange', wake);
  addEventListener('online', wake);

  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', wake);
    removeEventListener('online', wake);
  };
}

export function createHost({ onJoin, onMessage, onLeave, onError, onStatus }) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let opened = false;
    const connections = new Map(); // peerId -> DataConnection
    const beats = new Map();       // peerId -> stopHeartbeat

    function track(conn) {
      const prev = connections.get(conn.peer);
      if (prev && prev !== conn) {
        beats.get(conn.peer)?.();
        beats.delete(conn.peer);
        try { prev.close(); } catch {}
      }
      connections.set(conn.peer, conn);
      if (!beats.has(conn.peer)) beats.set(conn.peer, startHeartbeat(conn));
    }

    function drop(conn) {
      if (connections.get(conn.peer) !== conn) return; // superseded by a newer link
      connections.delete(conn.peer);
      beats.get(conn.peer)?.();
      beats.delete(conn.peer);
      onLeave?.(conn.peer);
    }

    function bind(conn) {
      track(conn);
      conn.on('open', () => track(conn));
      conn.on('data', (data) => {
        if (isControl(data)) {
          if (data.t === '_ping') sendWhenOpen(conn, { t: '_pong' });
          return;
        }
        onMessage?.(conn.peer, data, conn);
      });
      conn.on('close', () => drop(conn));
      conn.on('error', () => { if (!conn.open) drop(conn); });

      const meta = conn.metadata;
      if (meta && typeof meta === 'object' && (meta.name || meta.pid)) {
        onMessage?.(conn.peer, { t: 'join', name: meta.name, pid: meta.pid }, conn);
      }
      onJoin?.(conn);
    }

    function tryCode() {
      const code = randomCode();
      const peer = makePeer(peerIdForCode(code));

      peer.on('connection', bind);

      peer.on('open', () => {
        if (opened) return; // a signaling reconnect, not a new room
        opened = true;
        const stopKeepAlive = keepSignalingAlive(peer, onStatus);
        onStatus?.('online');
        resolve({
          code,
          peer,
          broadcast(msg) {
            for (const c of connections.values()) sendWhenOpen(c, msg);
          },
          sendTo(id, msg, via) {
            sendWhenOpen(via || connections.get(id), msg);
          },
          count() { return connections.size; },
          close() {
            stopKeepAlive();
            for (const stop of beats.values()) stop();
            beats.clear();
            try { peer.destroy(); } catch {}
          },
        });
      });

      peer.on('error', (err) => {
        const transient = ['unavailable-id', 'network', 'server-error', 'socket-error', 'socket-closed'];
        if (!opened && transient.includes(err.type) && attempts < 6) {
          attempts++;
          try { peer.destroy(); } catch {}
          setTimeout(tryCode, err.type === 'unavailable-id' ? 0 : 700 * attempts);
          return;
        }
        onError?.(err);
        if (!opened) reject(err);
      });
    }
    tryCode();
  });
}

export function createClient(code, { hello, onMessage, onClose, onError, onStatus }) {
  return new Promise((resolve, reject) => {
    const peer = makePeer();
    let settled = false;
    let leaving = false;
    let givenUp = false;
    let conn = null;
    let stopKeepAlive = null;
    let retryTimer = null;
    let hangTimer = null;
    let giveUpAt = 0;
    let gen = 0;
    let watch = null;

    const failTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        onError?.(new Error('timeout'));
        reject(new Error('Could not reach the room. Check the code.'));
      }
    }, JOIN_TRY_MS);

    const api = {
      peer,
      get conn() { return conn; },
      id: null,
      send(msg) { sendWhenOpen(conn, msg); },
      /** Send the join handshake and remember it, so a reconnect can resend it. */
      identify(msg) { hello = msg; api.send(msg); },
      close() {
        leaving = true;
        clearTimeout(retryTimer);
        clearTimeout(hangTimer);
        clearInterval(watch);
        stopKeepAlive?.();
        try { peer.destroy(); } catch {}
      },
    };

    function live() {
      return conn && conn.open && !leaving && !peer.destroyed;
    }

    function attach(c, myGen) {
      c.on('open', () => {
        if (leaving || myGen !== gen) {
          try { c.close(); } catch {}
          return;
        }
        if (conn && conn !== c) { try { conn.close(); } catch {} }
        conn = c;
        giveUpAt = 0;
        onStatus?.('online');
        if (hello) api.send(hello);
        if (!settled) {
          settled = true;
          clearTimeout(failTimer);
          api.id = peer.id;
          resolve(api);
        }
      });
      c.on('data', (data) => {
        if (conn !== c) return;
        if (isControl(data)) {
          if (data.t === '_ping') sendWhenOpen(c, { t: '_pong' });
          return;
        }
        onMessage?.(data);
      });
      c.on('close', () => {
        if (myGen !== gen) return;
        if (conn === c) conn = null;
        if (settled) retryLink();
        else scheduleRetry(800);
      });
      c.on('error', () => {
        if (myGen !== gen) return;
        if (conn === c && !c.open) conn = null;
        if (settled) retryLink();
        else scheduleRetry(800);
      });
    }

    function connectToHost() {
      if (leaving || peer.destroyed || peer.disconnected || live()) return;
      const myGen = ++gen;
      clearTimeout(hangTimer);
      let c;
      try {
        c = peer.connect(peerIdForCode(code), { ...CONN_OPTS, metadata: hello || {} });
      } catch {
        scheduleRetry(1000);
        return;
      }
      attach(c, myGen);
      hangTimer = setTimeout(() => {
        if (leaving || myGen !== gen || c.open) return;
        try { c.close(); } catch {}
        scheduleRetry(400);
      }, CONNECT_HANG_MS);
    }

    function scheduleRetry(ms) {
      if (leaving || retryTimer || peer.destroyed) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (leaving || peer.destroyed) return;
        if (peer.disconnected) return scheduleRetry(1000);
        connectToHost();
      }, ms);
    }

    /** Rebuild the data channel to the host, within a bounded window. */
    function retryLink() {
      if (leaving || givenUp || peer.destroyed || live()) return;
      if (!giveUpAt) { giveUpAt = Date.now() + REJOIN_WINDOW_MS; onStatus?.('reconnecting'); }
      if (Date.now() > giveUpAt) {
        givenUp = true;
        onClose?.();
        return;
      }
      scheduleRetry(1200);
    }

    peer.on('open', () => {
      if (!stopKeepAlive) {
        stopKeepAlive = keepSignalingAlive(peer, (s) => { if (s === 'reconnecting') onStatus?.(s); });
      }
      if (live()) return;
      if (settled) retryLink();
      else connectToHost();
    });

    peer.on('error', (err) => {
      // Host id often isn't queryable for a second or two after the room opens.
      if (err.type === 'peer-unavailable' || err.type === 'network' || err.type === 'server-error') {
        if (settled) retryLink();
        else scheduleRetry(1200);
        return;
      }
      if (settled) { onError?.(err); return; }
      settled = true;
      clearTimeout(failTimer);
      onError?.(err);
      reject(new Error(err.message || 'Connection error'));
    });

    watch = setInterval(() => {
      if (leaving || peer.destroyed || !settled) return;
      if (!live()) retryLink();
    }, 5000);
  });
}
