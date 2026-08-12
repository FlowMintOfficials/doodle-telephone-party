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

function makePeer(id) {
  return id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
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

    function tryCode() {
      const code = randomCode();
      const peer = makePeer(peerIdForCode(code));

      peer.on('connection', (conn) => {
        conn.on('open', () => { connections.set(conn.peer, conn); });
        conn.on('data', (data) => onMessage?.(conn.peer, data, conn));
        const drop = () => { connections.delete(conn.peer); onLeave?.(conn.peer); };
        conn.on('close', drop);
        conn.on('error', drop);
        onJoin?.(conn);
      });

      peer.on('open', () => {
        if (opened) return; // a signaling reconnect, not a new room
        opened = true;
        const stopKeepAlive = keepSignalingAlive(peer, onStatus);
        onStatus?.('online');
        resolve({
          code,
          peer,
          broadcast(msg) { for (const c of connections.values()) { try { c.send(msg); } catch {} } },
          sendTo(id, msg) { const c = connections.get(id); if (c) { try { c.send(msg); } catch {} } },
          count() { return connections.size; },
          close() { stopKeepAlive(); try { peer.destroy(); } catch {} },
        });
      });

      peer.on('error', (err) => {
        // Only an empty room may reroll its code; once players are holding it,
        // switching codes underneath them would strand everyone.
        if (!opened && err.type === 'unavailable-id' && attempts < 5) {
          attempts++;
          try { peer.destroy(); } catch {}
          tryCode();
          return;
        }
        onError?.(err);
        if (!opened) reject(err);
      });
    }
    tryCode();
  });
}

export function createClient(code, { onMessage, onClose, onError, onStatus }) {
  return new Promise((resolve, reject) => {
    const peer = makePeer();
    let settled = false;
    let leaving = false;
    let conn = null;
    let hello = null;       // replayed on every reconnect so the host knows us
    let stopKeepAlive = null;
    let retryTimer = null;
    let giveUpAt = 0;

    const failTimer = setTimeout(() => {
      if (!settled) { settled = true; onError?.(new Error('timeout')); reject(new Error('Could not reach the room. Check the code.')); }
    }, 12000);

    const api = {
      peer,
      get conn() { return conn; },
      id: null,
      send(msg) { try { conn?.send(msg); } catch {} },
      /** Send the join handshake and remember it, so a reconnect can resend it. */
      identify(msg) { hello = msg; api.send(msg); },
      close() {
        leaving = true;
        clearTimeout(retryTimer);
        stopKeepAlive?.();
        try { peer.destroy(); } catch {}
      },
    };

    function attach(c) {
      conn = c;
      c.on('open', () => {
        giveUpAt = 0;
        onStatus?.('online');
        if (settled) { if (hello) api.send(hello); return; }
        settled = true;
        clearTimeout(failTimer);
        api.id = peer.id;
        resolve(api);
      });
      c.on('data', (data) => onMessage?.(data));
      // A superseded connection can close long after we've moved on; ignore those.
      c.on('close', () => { if (settled && conn === c) retryLink(); });
      c.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(failTimer); reject(err); return; }
        if (conn === c) retryLink();
      });
    }

    /** Rebuild the data channel to the host, within a bounded window. */
    function retryLink() {
      if (leaving || peer.destroyed || retryTimer) return;
      if (!giveUpAt) { giveUpAt = Date.now() + REJOIN_WINDOW_MS; onStatus?.('reconnecting'); }
      if (Date.now() > giveUpAt) { giveUpAt = 0; onClose?.(); return; }

      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (leaving || peer.destroyed) return;
        if (peer.disconnected) return retryLink(); // keepSignalingAlive is on it
        try { attach(peer.connect(peerIdForCode(code), { reliable: true })); } catch { return retryLink(); }
        const pending = conn;
        // A connect to an absent host may never open or error; poke it ourselves.
        setTimeout(() => { if (conn === pending && !pending.open) retryLink(); }, 6000);
      }, 1500);
    }

    peer.on('open', () => {
      // For a player, "online" means reachable host, not merely a live broker,
      // so only the data channel opening is allowed to clear the warning.
      if (!stopKeepAlive) {
        stopKeepAlive = keepSignalingAlive(peer, (s) => { if (s === 'reconnecting') onStatus?.(s); });
      }
      if (settled) return; // back on the broker; retryLink owns the channel
      attach(peer.connect(peerIdForCode(code), { reliable: true }));
    });

    peer.on('error', (err) => {
      if (settled) {
        // The host may just be re-registering with the broker — keep trying.
        if (err.type === 'peer-unavailable') retryLink();
        else onError?.(err);
        return;
      }
      settled = true;
      clearTimeout(failTimer);
      const msg = err.type === 'peer-unavailable' ? 'No room found with that code.' : (err.message || 'Connection error');
      onError?.(err);
      reject(new Error(msg));
    });
  });
}
