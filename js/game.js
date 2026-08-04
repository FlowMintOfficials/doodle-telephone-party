/**
 * Doodle Telephone — pure game engine (no DOM, no rendering, no networking).
 *
 * Every player starts their own "chain" with a written sentence. Each round the
 * chains rotate one seat: you draw the sentence you received, then someone else
 * writes what they think your drawing shows, and so on. Nobody sees a chain
 * again until the reveal, when the whole mangled sequence gets played back.
 *
 * Chain `c` at step `s` is always handled by player `(c + s) % n`, so every
 * player works on a different chain each round and never revisits their own.
 */

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const MAX_STEPS = 8;

export const COLORS = [
  '#ff5d7a', '#3aa0ff', '#5ad86b', '#ffcf3a',
  '#b07bff', '#ff9640', '#3ad6c8', '#ff6ec4',
];

/** Step 0 is the seed sentence, then drawings and guesses alternate. */
export function kindForStep(step) {
  if (step === 0) return 'text';
  return step % 2 === 1 ? 'draw' : 'text';
}

export function createGame(playerList) {
  const n = playerList.length;
  return {
    phase: 'work', // 'work' | 'reveal' | 'vote' | 'done'
    step: 0,
    totalSteps: Math.max(2, Math.min(n, MAX_STEPS)),
    players: playerList.map((p, i) => ({
      id: p.id ?? `p${i}`,
      name: p.name || `Player ${i + 1}`,
      color: COLORS[i % COLORS.length],
    })),
    chains: Array.from({ length: n }, (_, i) => ({ owner: i, entries: [] })),
    votes: {}, // voterIndex -> chainIndex
  };
}

/** Which chain a given player works on during a given step. */
export function chainForPlayer(state, playerIndex, step) {
  const n = state.players.length;
  return (((playerIndex - step) % n) + n) % n;
}

/** Which player is responsible for a chain at a given step. */
export function authorForChain(state, chainIndex, step) {
  return (chainIndex + step) % state.players.length;
}

/** The entry the current worker is responding to (null on the seed step). */
export function priorEntry(state, chainIndex, step) {
  return step > 0 ? state.chains[chainIndex].entries[step - 1] ?? null : null;
}

export function submitEntry(state, chainIndex, step, value) {
  state.chains[chainIndex].entries[step] = {
    by: authorForChain(state, chainIndex, step),
    kind: kindForStep(step),
    value,
  };
}

export function hasSubmitted(state, chainIndex, step) {
  return state.chains[chainIndex].entries[step] !== undefined;
}

export function submittedCount(state, step) {
  return state.chains.filter((c) => c.entries[step] !== undefined).length;
}

export function stepComplete(state, step) {
  return submittedCount(state, step) === state.chains.length;
}

/** Backfill anyone who ran out of time so the round can always advance. */
export function fillMissing(state, step) {
  state.chains.forEach((c, i) => {
    if (c.entries[step] === undefined) {
      submitEntry(state, i, step, kindForStep(step) === 'text' ? '(ran out of time!)' : []);
    }
  });
}

export function isLastStep(state) {
  return state.step >= state.totalSteps - 1;
}

/** Tally favourite-chain votes; returns { winner, counts }. */
export function tallyVotes(state) {
  const counts = new Array(state.chains.length).fill(0);
  for (const chainIndex of Object.values(state.votes)) {
    if (counts[chainIndex] != null) counts[chainIndex] += 1;
  }
  let winner = 0;
  counts.forEach((v, i) => { if (v > counts[winner]) winner = i; });
  return { winner, counts };
}
