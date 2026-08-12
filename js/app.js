/**
 * Doodle Telephone — app orchestration.
 * Screens + timers + reveal playback, driven by the pure chain engine, and
 * played either pass-and-play on one device or online over PeerJS.
 */
import {
  createGame, kindForStep, chainForPlayer, priorEntry, submitEntry,
  stepComplete, submittedCount, fillMissing, tallyVotes,
  COLORS, MIN_PLAYERS, MAX_PLAYERS,
} from './game.js';
import { DrawPad, PALETTE, BRUSHES } from './draw.js';
import { randomPrompt } from './prompts.js';
import { createHost, createClient } from './net.js';

const $ = (s) => document.querySelector(s);
const clone = (x) => JSON.parse(JSON.stringify(x));

const TEXT_MS = 45000;
const DRAW_MS = 75000;
const DROP_GRACE_MS = 8000; // let a dropped player reconnect before answering for them

const G = {
  mode: null,           // 'pass' | 'host' | 'client'
  state: null,
  myIndex: null,
  pad: null,
  host: null, client: null,
  hostPlayers: [], peerIndex: new Map(), started: false,
  passPos: 0,
  curTask: null,
  tick: null, stepTimer: null, stepEndsAt: 0, dropTimers: new Map(),
  album: null, reveal: { chain: 0, entry: 0 },
  voted: null,
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
}

/** Banner for the signaling link, which can drop without the game noticing. */
function setNetStatus(status) {
  const bar = $('#netbar');
  bar.hidden = status !== 'reconnecting';
  bar.textContent = G.mode === 'host'
    ? '⚠️ Reconnecting… nobody can join with the code until this clears'
    : '⚠️ Connection lost — reconnecting…';
}

/**
 * A per-tab identity that survives a reload, so a player who drops out gets
 * their own seat back instead of turning up as a stranger.
 */
function myPid() {
  let pid = sessionStorage.getItem('dt-pid');
  if (!pid) { pid = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('dt-pid', pid); }
  return pid;
}

// ---- HOME -----------------------------------------------------------------
document.querySelectorAll('.mode-card').forEach((card) => {
  card.addEventListener('click', () => {
    const mode = card.dataset.mode;
    ['pass', 'host', 'join'].forEach((m) => { $(`#panel-${m}`).hidden = m !== mode; });
    if (mode === 'pass') buildNames(currentCount());
  });
});
document.querySelectorAll('[data-back]').forEach((b) =>
  b.addEventListener('click', () => document.querySelectorAll('.panel').forEach((p) => (p.hidden = true)))
);

function currentCount() { return +($('#count-row .on')?.dataset.n || 4); }

$('#count-row').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  $('#count-row').querySelectorAll('button').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  buildNames(+btn.dataset.n);
});

function buildNames(n) {
  const wrap = $('#pass-names');
  const prev = [...wrap.querySelectorAll('input')].map((i) => i.value);
  wrap.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'name-row';
    row.innerHTML = `<span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>`;
    const input = document.createElement('input');
    input.maxLength = 12;
    input.placeholder = `Player ${i + 1}`;
    input.value = prev[i] || '';
    row.appendChild(input);
    wrap.appendChild(row);
  }
}

$('#pass-start').addEventListener('click', () => {
  const players = [...$('#pass-names').querySelectorAll('input')].map((inp, i) => ({
    id: `p${i}`, name: (inp.value.trim() || `Player ${i + 1}`).slice(0, 12),
  }));
  G.mode = 'pass';
  G.state = createGame(players);
  G.passPos = 0;
  passAdvance();
});

// ---- ONLINE: host ---------------------------------------------------------
$('#host-create').addEventListener('click', async () => {
  const name = ($('#host-name').value.trim() || 'Host').slice(0, 12);
  G.mode = 'host'; G.myIndex = 0; G.started = false;
  G.hostPlayers = [{ id: 'host', name }];
  G.peerIndex = new Map();
  try {
    G.host = await createHost({ onMessage: hostOnMessage, onLeave: hostOnLeave, onStatus: setNetStatus });
    showLobby(G.host.code, true);
  } catch {
    alert('Could not create a room. Please try again.');
  }
});

function hostOnMessage(peerId, data) {
  if (!data || typeof data !== 'object') return;
  if (data.t === 'join') {
    const seat = data.pid ? G.hostPlayers.findIndex((p) => p.pid === data.pid) : -1;
    if (seat > -1) return hostReadmit(peerId, seat);
    if (G.started) return G.host.sendTo(peerId, { t: 'err', m: 'That game already started.' });
    if (G.hostPlayers.length >= MAX_PLAYERS) return G.host.sendTo(peerId, { t: 'err', m: `Room is full (${MAX_PLAYERS} max).` });
    const index = G.hostPlayers.length;
    G.hostPlayers.push({ id: peerId, pid: data.pid, name: (data.name || 'Player').slice(0, 12) });
    reindexPeers();
    G.host.sendTo(peerId, { t: 'welcome', index, code: G.host.code });
    broadcastLobby();
    showLobby(G.host.code, true);
  } else if (data.t === 'submit') {
    if (!G.started || data.step !== G.state.step) return;
    submitEntry(G.state, data.chain, data.step, data.value);
    hostBroadcastProgress();
    if (stepComplete(G.state, G.state.step)) hostFinishStep();
  } else if (data.t === 'vote') {
    const idx = G.peerIndex.get(peerId);
    if (idx == null || G.state.phase !== 'vote') return;
    G.state.votes[idx] = data.chain;
    hostCheckVotes();
  }
}

function reindexPeers() {
  G.peerIndex = new Map();
  G.hostPlayers.forEach((p, i) => { if (p.id !== 'host') G.peerIndex.set(p.id, i); });
}

/** A player who dropped is back on a fresh connection: rebind their seat and resync. */
function hostReadmit(peerId, index) {
  clearTimeout(G.dropTimers.get(index));
  G.dropTimers.delete(index);
  G.hostPlayers[index].id = peerId;
  reindexPeers();
  G.host.sendTo(peerId, { t: 'welcome', index, code: G.host.code });

  if (!G.started) {
    broadcastLobby();
    showLobby(G.host.code, true);
    return;
  }

  const s = G.state;
  G.host.sendTo(peerId, { t: 'begin', players: s.players, totalSteps: s.totalSteps });

  if (s.phase === 'work') {
    const chain = chainForPlayer(s, index, s.step);
    if (s.chains[chain].entries[s.step] === undefined) {
      G.host.sendTo(peerId, {
        t: 'task', step: s.step, chain, kind: kindForStep(s.step),
        ms: Math.max(5000, G.stepEndsAt - Date.now()),
        prior: priorEntry(s, chain, s.step), total: s.totalSteps,
      });
    } else {
      G.host.sendTo(peerId, { t: 'progress', done: submittedCount(s, s.step), total: s.chains.length });
    }
    return;
  }

  G.host.sendTo(peerId, { t: 'album', album: clone(G.album) });
  if (s.phase === 'vote') G.host.sendTo(peerId, { t: 'votestart' });
  else G.host.sendTo(peerId, { t: 'revealAt', ...G.reveal });
}

function hostOnLeave(peerId) {
  const idx = G.peerIndex.get(peerId);
  if (idx == null) return;
  if (!G.started) {
    G.hostPlayers.splice(idx, 1);
    reindexPeers();
    broadcastLobby();
    showLobby(G.host.code, true);
    return;
  }

  // Don't stall the round waiting on someone who left — but give them a moment
  // to reconnect first, so a brief blip doesn't cost them their turn.
  clearTimeout(G.dropTimers.get(idx));
  G.dropTimers.set(idx, setTimeout(() => {
    G.dropTimers.delete(idx);
    if (!G.started || G.hostPlayers[idx]?.id !== peerId) return; // gone, or already back
    if (G.state.phase === 'work') {
      const chain = chainForPlayer(G.state, idx, G.state.step);
      if (G.state.chains[chain].entries[G.state.step] !== undefined) return;
      submitEntry(G.state, chain, G.state.step, kindForStep(G.state.step) === 'text' ? '(player left)' : []);
      hostBroadcastProgress();
      if (stepComplete(G.state, G.state.step)) hostFinishStep();
    } else if (G.state.phase === 'vote' && G.state.votes[idx] == null) {
      G.state.votes[idx] = -1; // abstain, so the tally isn't held up forever
      hostCheckVotes();
    }
  }, DROP_GRACE_MS));
}

function broadcastLobby() { G.host.broadcast({ t: 'lobby', players: lobbyView() }); }
function lobbyView() {
  return G.hostPlayers.map((p, i) => ({ name: p.name, color: COLORS[i % COLORS.length] }));
}

$('#lobby-start').addEventListener('click', () => {
  if (G.mode !== 'host') return;
  if (G.hostPlayers.length < MIN_PLAYERS) {
    $('#lobby-hint').textContent = `Need at least ${MIN_PLAYERS} players to start.`;
    return;
  }
  G.started = true;
  G.state = createGame(G.hostPlayers.map((p) => ({ id: p.id, name: p.name })));
  G.host.broadcast({ t: 'begin', players: G.state.players, totalSteps: G.state.totalSteps });
  hostStartStep();
});

function hostStartStep() {
  const s = G.state;
  const kind = kindForStep(s.step);
  const ms = kind === 'draw' ? DRAW_MS : TEXT_MS;
  G.stepEndsAt = Date.now() + ms;

  for (let i = 1; i < s.players.length; i++) {
    const chain = chainForPlayer(s, i, s.step);
    G.host.sendTo(G.hostPlayers[i].id, {
      t: 'task', step: s.step, chain, kind, ms,
      prior: priorEntry(s, chain, s.step), total: s.totalSteps,
    });
  }
  beginLocalTask(0, ms);

  clearTimeout(G.stepTimer);
  G.stepTimer = setTimeout(() => {
    fillMissing(s, s.step);
    hostFinishStep();
  }, ms + 4000);
}

function hostBroadcastProgress() {
  G.host.broadcast({ t: 'progress', done: submittedCount(G.state, G.state.step), total: G.state.chains.length });
  updateWaiting(submittedCount(G.state, G.state.step), G.state.chains.length);
}

function hostFinishStep() {
  clearTimeout(G.stepTimer);
  G.state.step += 1;
  if (G.state.step >= G.state.totalSteps) hostStartReveal();
  else hostStartStep();
}

function hostStartReveal() {
  G.state.phase = 'reveal';
  G.album = { players: G.state.players, chains: G.state.chains };
  G.host.broadcast({ t: 'album', album: clone(G.album) });
  G.reveal = { chain: 0, entry: 0 };
  G.host.broadcast({ t: 'revealAt', ...G.reveal });
  renderReveal();
}

// ---- ONLINE: client -------------------------------------------------------
$('#join-go').addEventListener('click', async () => {
  const name = ($('#join-name').value.trim() || 'Player').slice(0, 12);
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length < 3) { $('#join-err').textContent = 'Enter the room code.'; return; }
  $('#join-err').textContent = '';
  $('#join-go').disabled = true;
  G.mode = 'client';
  try {
    G.client = await createClient(code, { onMessage: clientOnMessage, onClose: onLinkLost, onStatus: setNetStatus });
    G.client.identify({ t: 'join', name, pid: myPid() });
    showLobby(code, false);
  } catch (e) {
    $('#join-err').textContent = e.message || 'Could not join.';
  } finally {
    $('#join-go').disabled = false;
  }
});

function clientOnMessage(data) {
  if (!data || typeof data !== 'object') return;
  switch (data.t) {
    case 'welcome':
      G.myIndex = data.index;
      if (data.code) $('#lobby-code').textContent = data.code;
      break;
    case 'lobby': G.lobbyList = data.players; showLobby($('#lobby-code').textContent, false); break;
    case 'begin':
      G.started = true;
      G.state = { players: data.players, totalSteps: data.totalSteps, step: 0, phase: 'work' };
      break;
    case 'task':
      G.state.step = data.step;
      showTaskScreen({ step: data.step, chain: data.chain, kind: data.kind, prior: data.prior, total: data.total, ms: data.ms });
      break;
    case 'progress':
      if (!G.curTask) showWaiting(); // covers rejoining a step we already answered
      updateWaiting(data.done, data.total);
      break;
    case 'album': G.album = data.album; break;
    case 'revealAt': G.reveal = { chain: data.chain, entry: data.entry }; renderReveal(); break;
    case 'votestart': showVote(); break;
    case 'result': showDone(data.winner, data.counts); break;
    case 'err': $('#join-err').textContent = data.m || 'Error'; goHome(); break;
  }
}

/** Only fires once net.js has exhausted its reconnect window. */
function onLinkLost() {
  if (G.state?.phase === 'done') return;
  alert("Lost the connection to the room and couldn't get back in.");
  goHome();
}

// ---- LOBBY ----------------------------------------------------------------
function showLobby(code, isHost) {
  showScreen('screen-lobby');
  $('#lobby-code').textContent = code || '----';
  $('#lobby-start').hidden = !isHost;
  const list = isHost ? lobbyView() : (G.lobbyList || []);
  $('#lobby-hint').textContent = isHost
    ? `Share the code. ${MIN_PLAYERS}–${MAX_PLAYERS} players, start when everyone's in.`
    : 'Waiting for the host to start…';
  const ul = $('#lobby-players');
  ul.innerHTML = '';
  list.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}` +
      (i === G.myIndex ? '<span class="you">You</span>' : '');
    ul.appendChild(li);
  });
}

$('#copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText($('#lobby-code').textContent).then(() => {
    $('#copy-code').textContent = 'Copied!';
    setTimeout(() => ($('#copy-code').textContent = 'Copy'), 1200);
  });
});
$('#lobby-leave').addEventListener('click', goHome);
$('#reveal-leave').addEventListener('click', goHome);

// ---- PASS & PLAY ----------------------------------------------------------
function passAdvance() {
  const s = G.state;
  if (G.passPos >= s.players.length) {
    G.passPos = 0;
    s.step += 1;
    if (s.step >= s.totalSteps) { startLocalReveal(); return; }
  }
  showScreen('screen-handoff');
  $('#handoff-name').textContent = s.players[G.passPos].name;
}

$('#handoff-ready').addEventListener('click', () => {
  const kind = kindForStep(G.state.step);
  beginLocalTask(G.passPos, kind === 'draw' ? DRAW_MS : TEXT_MS);
});

/** Build and show the task for a player whose state we hold locally. */
function beginLocalTask(playerIndex, ms) {
  const s = G.state;
  const chain = chainForPlayer(s, playerIndex, s.step);
  showTaskScreen({
    step: s.step, chain, kind: kindForStep(s.step),
    prior: priorEntry(s, chain, s.step), total: s.totalSteps, ms,
    who: G.mode === 'pass' ? s.players[playerIndex].name : null,
  });
}

// ---- TASK SCREEN ----------------------------------------------------------
function showTaskScreen({ step, chain, kind, prior, total, ms, who }) {
  G.curTask = { step, chain, kind };
  showScreen('screen-task');

  $('#task-sub').textContent = `Round ${step + 1} of ${total}` + (who ? ` · ${who}` : '');
  const isText = kind === 'text';
  $('#answer-text').hidden = !isText;
  $('#answer-draw').hidden = isText;
  $('#prior-text').hidden = true;
  $('#prior-draw').hidden = true;

  if (isText) {
    $('#task-title').textContent = step === 0 ? '✏️ Write a sentence' : '🤔 What is this?';
    $('#surprise').hidden = step !== 0;
    $('#text-input').value = '';
    $('#text-input').placeholder = step === 0 ? 'Something absurd works best…' : 'Describe what you see…';
    if (prior) {
      $('#prior-draw').hidden = false;
      requestAnimationFrame(() => renderInto($('#prior-canvas'), prior.value));
    }
    setTimeout(() => $('#text-input').focus(), 60);
  } else {
    $('#task-title').textContent = '🎨 Draw it!';
    $('#prior-text').hidden = false;
    $('#prior-text-value').textContent = prior?.value ?? '';
    ensurePad();
    G.pad.clear();
    requestAnimationFrame(() => G.pad.resize());
  }

  $('#submit-btn').textContent = 'Done →';
  $('#submit-btn').disabled = false;
  startTimer(ms, () => submitCurrent(true));
}

function ensurePad() {
  if (G.pad) return G.pad;
  G.pad = new DrawPad($('#pad'));
  // colour swatches
  const sw = $('#swatches');
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.style.background = c;
    b.className = i === 0 ? 'on' : '';
    b.addEventListener('click', () => {
      sw.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      $('#tool-eraser').classList.remove('on');
      G.pad.setTool({ color: c });
    });
    sw.appendChild(b);
  });
  // brush sizes
  const br = $('#brushes');
  BRUSHES.forEach((w, i) => {
    const b = document.createElement('button');
    b.className = i === 1 ? 'on' : '';
    const dot = document.createElement('i');
    const px = Math.max(4, Math.round(w * 300));
    dot.style.width = dot.style.height = `${px}px`;
    b.appendChild(dot);
    b.addEventListener('click', () => {
      br.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      G.pad.setTool({ size: w });
    });
    br.appendChild(b);
  });
  $('#tool-eraser').addEventListener('click', () => {
    const on = !$('#tool-eraser').classList.contains('on');
    $('#tool-eraser').classList.toggle('on', on);
    G.pad.setTool({ eraser: on });
  });
  $('#tool-undo').addEventListener('click', () => G.pad.undo());
  $('#tool-clear').addEventListener('click', () => G.pad.clear());
  return G.pad;
}

$('#surprise').addEventListener('click', () => { $('#text-input').value = randomPrompt(); });
$('#text-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCurrent(); });
$('#submit-btn').addEventListener('click', () => submitCurrent());

function submitCurrent(auto = false) {
  const task = G.curTask;
  if (!task) return;
  let value;
  if (task.kind === 'text') {
    value = $('#text-input').value.trim();
    if (!value) {
      if (!auto) return nudge('Write something first!');
      value = '(ran out of time!)';
    }
  } else {
    value = G.pad.getStrokes();
    if (!value.length && !auto) return nudge('Draw something first!');
    value = clone(value);
  }
  G.curTask = null;
  stopTimer();

  if (G.mode === 'client') {
    G.client.send({ t: 'submit', step: task.step, chain: task.chain, value });
    showWaiting();
    return;
  }

  submitEntry(G.state, task.chain, task.step, value);

  if (G.mode === 'pass') {
    G.passPos += 1;
    passAdvance();
  } else { // host
    showWaiting();
    hostBroadcastProgress();
    if (stepComplete(G.state, G.state.step)) hostFinishStep();
  }
}

function nudge(msg) {
  const b = $('#submit-btn');
  const old = b.textContent;
  b.textContent = msg;
  setTimeout(() => { b.textContent = old; }, 1200);
}

// ---- TIMER ----------------------------------------------------------------
function startTimer(ms, onExpire) {
  stopTimer();
  if (!ms) { $('#timer').textContent = ''; $('#timer-fill').style.width = '100%'; return; }
  const end = Date.now() + ms;
  const paint = () => {
    const left = Math.max(0, end - Date.now());
    const secs = Math.ceil(left / 1000);
    $('#timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    $('#timer').classList.toggle('low', secs <= 10);
    $('#timer-fill').style.width = `${(left / ms) * 100}%`;
    if (left <= 0) { stopTimer(); onExpire?.(); }
  };
  paint();
  G.tick = setInterval(paint, 200);
}
function stopTimer() { clearInterval(G.tick); G.tick = null; $('#timer').classList.remove('low'); }

// ---- WAITING --------------------------------------------------------------
function showWaiting() {
  showScreen('screen-waiting');
  const total = G.state?.chains?.length || G.state?.players?.length || 1;
  updateWaiting(G.mode === 'host' ? submittedCount(G.state, G.state.step) : 0, total);
}
function updateWaiting(done, total) {
  $('#waiting-fill').style.width = `${(done / total) * 100}%`;
  $('#waiting-text').textContent = `Waiting for everyone else… ${done}/${total} done`;
}

// ---- REVEAL ---------------------------------------------------------------
function startLocalReveal() {
  G.state.phase = 'reveal';
  G.album = { players: G.state.players, chains: G.state.chains };
  G.reveal = { chain: 0, entry: 0 };
  renderReveal();
}

function canDriveReveal() { return G.mode === 'pass' || G.mode === 'host'; }

async function renderReveal() {
  const { players, chains } = G.album;
  const { chain, entry } = G.reveal;
  const c = chains[chain];
  showScreen('screen-reveal');

  $('#reveal-title').textContent = `Chain ${chain + 1} of ${chains.length}`;
  $('#reveal-sub').textContent = `started by ${players[c.owner].name}`;
  $('#reveal-next').hidden = !canDriveReveal();
  $('#reveal-wait').hidden = canDriveReveal();

  const dots = $('#reveal-dots');
  dots.innerHTML = '';
  c.entries.forEach((_, i) => {
    const s = document.createElement('span');
    if (i <= entry) s.className = 'on';
    dots.appendChild(s);
  });

  const e = c.entries[entry];
  const author = players[e.by]?.name || '???';
  $('#reveal-by').textContent = entry === 0 ? `${author} wrote:` : (e.kind === 'draw' ? `${author} drew:` : `${author} guessed:`);

  const isText = e.kind === 'text';
  $('#reveal-text').hidden = !isText;
  $('#reveal-draw').hidden = isText;
  const last = entry >= c.entries.length - 1;
  $('#reveal-next').textContent = last
    ? (chain >= chains.length - 1 ? 'Finish →' : 'Next chain →')
    : 'Next →';

  if (isText) {
    $('#reveal-text').textContent = `“${e.value}”`;
  } else {
    const canvas = $('#reveal-canvas');
    requestAnimationFrame(async () => {
      sizeCanvas(canvas);
      await DrawPad.replay(canvas.getContext('2d'), e.value, canvas.width, canvas.height, 1800);
    });
  }
}

$('#reveal-next').addEventListener('click', () => {
  if (!canDriveReveal()) return;
  const chains = G.album.chains;
  let { chain, entry } = G.reveal;
  entry += 1;
  if (entry >= chains[chain].entries.length) { chain += 1; entry = 0; }
  if (chain >= chains.length) {
    if (G.mode === 'host') { G.state.phase = 'vote'; G.host.broadcast({ t: 'votestart' }); showVote(); }
    else showDone(null, null);
    return;
  }
  G.reveal = { chain, entry };
  if (G.mode === 'host') G.host.broadcast({ t: 'revealAt', ...G.reveal });
  renderReveal();
});

// ---- VOTE -----------------------------------------------------------------
function showVote() {
  showScreen('screen-vote');
  G.voted = null;
  const { players, chains } = G.album;
  const ul = $('#vote-list');
  ul.innerHTML = '';
  chains.forEach((c, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.innerHTML = `<span class="swatch" style="background:${players[c.owner].color}"></span>` +
      `${escapeHtml(players[c.owner].name)}'s chain`;
    b.addEventListener('click', () => {
      if (G.voted != null) return;
      G.voted = i;
      ul.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      $('#vote-status').textContent = 'Vote locked in — waiting for the others…';
      if (G.mode === 'client') G.client.send({ t: 'vote', chain: i });
      else { G.state.votes[0] = i; hostCheckVotes(); }
    });
    li.appendChild(b);
    ul.appendChild(li);
  });
  $('#vote-status').textContent = '';
}

function hostCheckVotes() {
  const n = G.state.players.length;
  if (Object.keys(G.state.votes).length >= n) {
    const { winner, counts } = tallyVotes(G.state);
    G.host.broadcast({ t: 'result', winner, counts });
    showDone(winner, counts);
  }
}

// ---- DONE -----------------------------------------------------------------
function showDone(winner, counts) {
  if (G.state) G.state.phase = 'done';
  showScreen('screen-done');
  if (winner != null && G.album) {
    const owner = G.album.players[G.album.chains[winner].owner];
    $('#done-title').textContent = `${owner.name}'s chain wins! 🏆`;
    $('#done-sub').textContent = `${counts[winner]} vote${counts[winner] === 1 ? '' : 's'} for the biggest disaster.`;
  } else {
    $('#done-title').textContent = "That's all, folks!";
    $('#done-sub').textContent = 'Hope somebody snorted.';
  }
  $('#done-replay').hidden = !canDriveReveal();
  $('#done-again').hidden = !(G.mode === 'pass' || G.mode === 'host');
  makeConfetti();
}

$('#done-replay').addEventListener('click', () => {
  G.reveal = { chain: 0, entry: 0 };
  if (G.mode === 'host') G.host.broadcast({ t: 'revealAt', ...G.reveal });
  renderReveal();
});

$('#done-again').addEventListener('click', () => {
  if (G.mode === 'pass') {
    G.state = createGame(G.state.players.map((p) => ({ id: p.id, name: p.name })));
    G.passPos = 0;
    passAdvance();
  } else if (G.mode === 'host') {
    G.state = createGame(G.hostPlayers.map((p) => ({ id: p.id, name: p.name })));
    G.host.broadcast({ t: 'begin', players: G.state.players, totalSteps: G.state.totalSteps });
    hostStartStep();
  }
});
$('#done-home').addEventListener('click', goHome);

function makeConfetti() {
  const box = $('#confetti');
  box.innerHTML = '';
  const cols = ['#12b6a4', '#ffd23b', '#ff6b8b', '#4f7dff', '#8b5cff', '#37c85a'];
  for (let i = 0; i < 54; i++) {
    const s = document.createElement('span');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = cols[i % cols.length];
    s.style.animationDuration = `${2 + Math.random() * 2.5}s`;
    s.style.animationDelay = `${Math.random() * 1.5}s`;
    box.appendChild(s);
  }
}

// ---- helpers --------------------------------------------------------------
function sizeCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function renderInto(canvas, strokes) {
  sizeCanvas(canvas);
  DrawPad.render(canvas.getContext('2d'), strokes, canvas.width, canvas.height);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

addEventListener('resize', () => {
  if (G.pad && !$('#answer-draw').hidden) G.pad.resize();
});

function goHome() {
  stopTimer();
  clearTimeout(G.stepTimer);
  G.dropTimers.forEach((t) => clearTimeout(t));
  try { G.host?.close(); } catch {}
  try { G.client?.close(); } catch {}
  Object.assign(G, {
    mode: null, state: null, myIndex: null, host: null, client: null,
    hostPlayers: [], peerIndex: new Map(), started: false, passPos: 0,
    curTask: null, album: null, reveal: { chain: 0, entry: 0 }, voted: null, lobbyList: [],
    stepEndsAt: 0, dropTimers: new Map(),
  });
  $('#netbar').hidden = true;
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
  showScreen('screen-home');
}
