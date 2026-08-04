/**
 * Doodle Telephone — drawing surface.
 *
 * Drawings are stored as *stroke vectors*, not images: each stroke is a colour,
 * a width, and a flat list of points, all normalised to 0..1 of the canvas box.
 * That keeps them tiny to send over the P2P link, crisp at any screen size, and
 * replayable stroke-by-stroke during the reveal.
 *
 * Stroke shape: { c: '#hex', w: 0.012, e: 1?, p: [x0,y0,x1,y1,...] }
 *   c = colour, w = width as a fraction of canvas width, e = eraser, p = points
 */

export const PAD_BG = '#ffffff';
export const BRUSHES = [0.006, 0.013, 0.026, 0.05];
export const PALETTE = [
  '#241b4a', '#ff3b6b', '#ff8f3b', '#ffd23b',
  '#37c85a', '#3aa0ff', '#8b5cff', '#ff6ec4',
  '#8a5a2b', '#9aa3b8',
];

const r3 = (v) => Math.round(v * 1000) / 1000;

export class DrawPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.cur = null;
    this.color = PALETTE[0];
    this.size = BRUSHES[1];
    this.eraser = false;
    this.locked = false;
    this.onChange = null;
    this._bind();
    this.resize();
  }

  _bind() {
    const c = this.canvas;
    c.style.touchAction = 'none'; // let us handle drags without the page scrolling

    const at = (e) => {
      const r = c.getBoundingClientRect();
      return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
    };

    c.addEventListener('pointerdown', (e) => {
      if (this.locked) return;
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch {}
      const [x, y] = at(e);
      this.cur = { c: this.color, w: this.size, p: [r3(x), r3(y)] };
      if (this.eraser) this.cur.e = 1;
      this.strokes.push(this.cur);
      this._redraw();
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.cur || this.locked) return;
      e.preventDefault();
      const [x, y] = at(e);
      const p = this.cur.p;
      const dx = x - p[p.length - 2];
      const dy = y - p[p.length - 1];
      if (dx * dx + dy * dy < 0.000012) return; // skip jitter
      p.push(r3(x), r3(y));
      this._redraw();
    });

    const end = () => {
      if (!this.cur) return;
      this.cur = null;
      this.onChange?.();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  setTool({ color, size, eraser }) {
    if (color != null) { this.color = color; this.eraser = false; }
    if (size != null) this.size = size;
    if (eraser != null) this.eraser = eraser;
  }

  undo() { this.strokes.pop(); this._redraw(); this.onChange?.(); }
  clear() { this.strokes = []; this._redraw(); this.onChange?.(); }
  getStrokes() { return this.strokes; }
  isEmpty() { return this.strokes.length === 0; }

  setStrokes(strokes) {
    this.strokes = strokes ? JSON.parse(JSON.stringify(strokes)) : [];
    this._redraw();
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this._redraw();
  }

  _redraw() {
    DrawPad.render(this.ctx, this.strokes, this.canvas.width, this.canvas.height);
  }

  // ---- static rendering helpers -------------------------------------------

  static render(ctx, strokes, w, h) {
    ctx.fillStyle = PAD_BG;
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes || []) DrawPad._stroke(ctx, s, w, h);
  }

  static _stroke(ctx, s, w, h, maxSegments = Infinity) {
    const p = s.p;
    if (!p || p.length < 2) return;
    ctx.strokeStyle = s.e ? PAD_BG : s.c;
    ctx.fillStyle = s.e ? PAD_BG : s.c;
    const lw = Math.max(1, s.w * w);
    ctx.lineWidth = lw;

    if (p.length === 2) { // a single tap becomes a dot
      ctx.beginPath();
      ctx.arc(p[0] * w, p[1] * h, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(p[0] * w, p[1] * h);
    const segs = Math.min(p.length / 2 - 1, maxSegments);
    for (let i = 1; i <= segs; i++) ctx.lineTo(p[i * 2] * w, p[i * 2 + 1] * h);
    ctx.stroke();
  }

  static segmentCount(strokes) {
    return (strokes || []).reduce((a, s) => a + Math.max(1, (s.p?.length || 0) / 2 - 1), 0);
  }

  /** Redraw the whole picture progressively, as if it were being drawn live. */
  static replay(ctx, strokes, w, h, ms = 2000) {
    return new Promise((resolve) => {
      const total = DrawPad.segmentCount(strokes) || 1;
      const start = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - start) / ms);
        const target = Math.ceil(t * total);
        ctx.fillStyle = PAD_BG;
        ctx.fillRect(0, 0, w, h);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        let drawn = 0;
        for (const s of strokes || []) {
          const segs = Math.max(1, (s.p?.length || 0) / 2 - 1);
          const take = Math.min(segs, target - drawn);
          if (take <= 0) break;
          DrawPad._stroke(ctx, s, w, h, take);
          drawn += segs;
        }
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }
}
