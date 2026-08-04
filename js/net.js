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

function makePeer(id) {
  return id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
}

export function createHost({ onJoin, onMessage, onLeave, onError }) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const connections = new Map(); // peerId -> DataConnection

    function tryCode() {
      const code = randomCode();
      const peer = makePeer(peerIdForCode(code));

      peer.on('open', () => {
        peer.on('connection', (conn) => {
          conn.on('open', () => { connections.set(conn.peer, conn); });
          conn.on('data', (data) => onMessage?.(conn.peer, data, conn));
          conn.on('close', () => { connections.delete(conn.peer); onLeave?.(conn.peer); });
          conn.on('error', () => { connections.delete(conn.peer); onLeave?.(conn.peer); });
          onJoin?.(conn);
        });

        resolve({
          code,
          peer,
          broadcast(msg) { for (const c of connections.values()) { try { c.send(msg); } catch {} } },
          sendTo(id, msg) { const c = connections.get(id); if (c) { try { c.send(msg); } catch {} } },
          count() { return connections.size; },
          close() { try { peer.destroy(); } catch {} },
        });
      });

      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && attempts < 5) {
          attempts++;
          try { peer.destroy(); } catch {}
          tryCode();
        } else {
          onError?.(err);
          reject(err);
        }
      });
    }
    tryCode();
  });
}

export function createClient(code, { onMessage, onClose, onError }) {
  return new Promise((resolve, reject) => {
    const peer = makePeer();
    let settled = false;

    const failTimer = setTimeout(() => {
      if (!settled) { settled = true; onError?.(new Error('timeout')); reject(new Error('Could not reach the room. Check the code.')); }
    }, 12000);

    peer.on('open', () => {
      const conn = peer.connect(peerIdForCode(code), { reliable: true });

      conn.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
        resolve({
          peer,
          conn,
          id: peer.id,
          send(msg) { try { conn.send(msg); } catch {} },
          close() { try { peer.destroy(); } catch {} },
        });
      });
      conn.on('data', (data) => onMessage?.(data));
      conn.on('close', () => onClose?.());
      conn.on('error', (err) => { if (!settled) { settled = true; clearTimeout(failTimer); reject(err); } });
    });

    peer.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimer);
      const msg = err.type === 'peer-unavailable' ? 'No room found with that code.' : (err.message || 'Connection error');
      onError?.(err);
      reject(new Error(msg));
    });
  });
}
