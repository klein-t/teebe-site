// teebe's "agent working" orb, drawn with the thinking-orbs engine
// (thinking-orbs 0.3.2 by Jakub Antalik, MIT License, https://libraries.dev/orbs),
// vendored unmodified in assets/vendor/thinking-orbs/ with its LICENSE.txt.
// Same preset as the app: state "solving" at size 20, white ink on a dark
// substrate, drawn at 0.85 scale, capped at 30 fps. It only animates while the
// orb is on screen, showing, and the tab is visible; reduced motion gets the
// library's static frame.
import { MODE_FRAMES, resolvePreset, paintFrame } from './vendor/thinking-orbs/engine.es.js';

const SIZE = 20, SCALE = 0.85, FRAME_MS = 1000 / 30, STATIC_T = 0.6;
const TINT = { r: 255, g: 255, b: 255 };
const { mode, speed, opts } = resolvePreset('solving', SIZE);
const geometry = MODE_FRAMES[mode];
const dpr = Math.min(2, window.devicePixelRatio || 1);
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

const orbs = Array.from(document.querySelectorAll('canvas.orb')).map((canvas) => {
  canvas.width = canvas.height = Math.round(SIZE * dpr);
  return { canvas, ctx: canvas.getContext('2d'), visible: false };
}).filter((o) => o.ctx);

const draw = (o, t) => {
  const { ctx } = o;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.translate(SIZE / 2, SIZE / 2);
  ctx.scale(SCALE, SCALE);
  ctx.translate(-SIZE / 2, -SIZE / 2);
  paintFrame(ctx, geometry(SIZE, t, opts), true, TINT);
};
// The story script swaps marks by data-m on the slot; skip work while hidden.
const showing = (o) => o.canvas.closest('[data-m="orb"]') !== null;

let raf = 0, last = 0;
const tick = (now) => {
  raf = 0;
  if (now - last >= FRAME_MS - 1) {
    last = now;
    const t = (now / 1000) * speed;
    orbs.forEach((o) => { if (o.visible && showing(o)) draw(o, t); });
  }
  schedule();
};
const schedule = () => {
  if (raf || reduce.matches || document.visibilityState === 'hidden') return;
  if (orbs.some((o) => o.visible)) raf = requestAnimationFrame(tick);
};

orbs.forEach((o) => draw(o, reduce.matches ? STATIC_T : (performance.now() / 1000) * speed));
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { const o = orbs.find((x) => x.canvas === e.target); if (o) o.visible = e.isIntersecting; });
    schedule();
  });
  orbs.forEach((o) => io.observe(o.canvas));
} else {
  orbs.forEach((o) => { o.visible = true; });
  schedule();
}
document.addEventListener('visibilitychange', schedule);
reduce.addEventListener('change', () => {
  if (reduce.matches) orbs.forEach((o) => draw(o, STATIC_T));
  schedule();
});
