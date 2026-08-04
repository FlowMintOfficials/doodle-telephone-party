# 🎨 Doodle Telephone

Write a sentence. Someone draws it. Someone else guesses the drawing without seeing
the original. Repeat… then watch every chain fall apart together at the reveal.

A party game for **3–8 friends** that runs entirely in the browser. No sign-up, no
backend, no app install. Built with vanilla HTML/CSS/JS and
[PeerJS](https://peerjs.com) for peer-to-peer multiplayer.

## 🎮 How to play

Pick a mode on the home screen:

- **📱 Pass & Play** — one device, passed around the room. A "no peeking" handoff
  screen sits between every turn.
- **🎉 Create Room** — get a 4-letter code and everyone plays on their own phone.
- **🔑 Join Room** — type a friend's code and your name.

Then:

1. **Round 1** — everyone writes a short, silly sentence. (Stuck? Hit **🎲 Surprise me**.)
2. **Round 2** — you receive *someone else's* sentence and draw it. 75 seconds.
3. **Round 3** — you receive *someone else's* drawing and write what you think it is. 45 seconds.
4. …and so on, until every chain has passed through everyone.
5. **The reveal** — each chain plays back one step at a time, with every drawing
   redrawn stroke-by-stroke, so you watch the meaning drift in real time.
6. **Vote** for the chain that broke you the hardest (online mode).

The rotation guarantees you never work on your own chain twice and never see the
same chain until the reveal.

## ✨ Nice details

- **Drawings are stroke vectors, not images.** Each drawing is stored as pen paths
  normalised to 0–1, so it's a few KB instead of a PNG blob, stays crisp on any
  screen size, and can be **replayed as an animation** during the reveal.
- **Drawing tools** — 10 colours, 4 brush sizes, eraser, undo, and clear.
- **Timers** with a countdown bar. Run out of time and whatever you have is
  submitted automatically, so nobody can stall the round.
- **Nobody gets stuck** — if a player disconnects mid-round, the host fills their
  slot so the game always advances.

## 📱 Mobile

- Drawing works with **touch, mouse, and stylus** via pointer events, with page
  scrolling disabled on the canvas so drags draw instead of scrolling.
- Notch/safe-area aware, no pull-to-refresh, 16px+ inputs so iOS doesn't zoom.
- Single-column layout and compact tools on small screens.
- Respects `prefers-reduced-motion`.

## 🚀 Run locally

It uses ES modules, so serve it over HTTP rather than opening the file directly:

```bash
cd doodle-telephone
python -m http.server 8166
# open http://127.0.0.1:8166/
```

## 🌐 Deploy (GitHub Pages / any static host)

Fully static with no build step, and all asset paths are relative — so it works at
a domain root or in a project subpath like `username.github.io/repo/doodle-telephone/`.
Commit the folder, enable **Settings → Pages → Deploy from a branch**, and you're live.
GitHub Pages serves over HTTPS, which is what PeerJS's secure broker needs.

> ⚠️ Online play uses the **free public PeerJS broker** for signaling. Great for
> playing with friends, but it's a shared community service with no uptime guarantee,
> and some strict corporate/school networks block P2P. **Pass & Play always works.**
> For bulletproof online play, self-host [peerjs-server](https://github.com/peers/peerjs-server)
> and point `net.js` at it.

## 📁 Structure

```
doodle-telephone/
├── index.html      # all screens: home, lobby, handoff, task, waiting, reveal, vote, done
├── styles.css      # cute cartoon theme, glass UI, animated background
└── js/
    ├── game.js     # pure chain engine: rotation, steps, submissions, votes
    ├── draw.js     # DrawPad: stroke capture, rendering, stroke-by-stroke replay
    ├── prompts.js  # 50 absurd seed sentences
    ├── net.js      # PeerJS host-as-hub wrapper (room codes)
    └── app.js      # orchestration: screens, timers, reveal, networking
```

`game.js` is deliberately pure — no DOM, no canvas, no networking — so the rotation
logic can be tested on its own and reused.

---

Grab some friends. Drawing badly is the whole point. 🎨
