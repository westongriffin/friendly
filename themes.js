// Friendly — event themes. Each theme is an expressive identity for an event
// page: a display font, a palette, an animated background (CSS class `t-<id>`
// defined in styles.css) and an optional canvas particle system.
//
// Backgrounds live in CSS so they render instantly and in thumbnails; this
// module owns the palette tokens, the font choice, and the particle layer.

export const THEMES = [
  { id: "confetti", name: "Confetti Pop", group: "Playful",
    font: "'Bricolage Grotesque'", ink: "#2E1A12", sub: "#7A5A48", accent: "#FF6B57",
    onAccent: "#fff", chip: "rgba(255,255,255,.72)", card: "rgba(255,255,255,.66)",
    particles: { kind: "confetti", colors: ["#FF6B57", "#FFC145", "#2E9E6B", "#5B8CFF", "#E85D9E"], density: 1 } },

  { id: "citrus", name: "Citrus Punch", group: "Playful",
    font: "'Bricolage Grotesque'", ink: "#3A1E00", sub: "#8A5A1E", accent: "#FF7A1A",
    onAccent: "#fff", chip: "rgba(255,255,255,.7)", card: "rgba(255,255,255,.6)",
    particles: { kind: "bubbles", colors: ["#FFD23F", "#FF7A1A", "#FF4E7A", "#FFF3C4"], density: .8 } },

  { id: "bubblegum", name: "Bubblegum", group: "Playful",
    font: "'Pacifico'", ink: "#5B1741", sub: "#A24C86", accent: "#FF4E9E",
    onAccent: "#fff", chip: "rgba(255,255,255,.72)", card: "rgba(255,255,255,.6)",
    particles: { kind: "bubbles", colors: ["#FF9EC9", "#FFD1E8", "#C77DFF", "#FFFFFF"], density: 1 } },

  { id: "sunset", name: "Sunset", group: "Warm",
    font: "'Fraunces'", ink: "#FFF4E6", sub: "#FFD9C0", accent: "#FFD166",
    onAccent: "#3A1500", chip: "rgba(0,0,0,.22)", card: "rgba(30,10,20,.28)",
    particles: { kind: "embers", colors: ["#FFD166", "#FF8C69", "#FF5E8A"], density: .5 } },

  { id: "golden", name: "Golden Hour", group: "Warm",
    font: "'Fraunces'", ink: "#3A2408", sub: "#8A6A2E", accent: "#C98A16",
    onAccent: "#fff", chip: "rgba(255,255,255,.6)", card: "rgba(255,250,236,.5)",
    particles: { kind: "embers", colors: ["#E8B84B", "#F5D283", "#C98A16"], density: .5 } },

  { id: "blossom", name: "Cherry Blossom", group: "Warm",
    font: "'Caprasimo'", ink: "#5A2438", sub: "#9A5A72", accent: "#FF7EA8",
    onAccent: "#fff", chip: "rgba(255,255,255,.7)", card: "rgba(255,255,255,.58)",
    particles: { kind: "petals", colors: ["#FFC2D6", "#FFD9E4", "#FF9EC0"], density: .9 } },

  { id: "garden", name: "Garden Party", group: "Fresh",
    font: "'DM Serif Display'", ink: "#183A24", sub: "#4A7A5A", accent: "#2E9E6B",
    onAccent: "#fff", chip: "rgba(255,255,255,.62)", card: "rgba(244,255,248,.5)",
    particles: { kind: "petals", colors: ["#8FD9A8", "#C5F0D2", "#5BBE86"], density: .7 } },

  { id: "aurora", name: "Aurora", group: "Fresh",
    font: "'Unbounded'", ink: "#EAFBF4", sub: "#9FD9C8", accent: "#57F0C0",
    onAccent: "#04241B", chip: "rgba(255,255,255,.12)", card: "rgba(10,30,30,.34)",
    particles: { kind: "stars", colors: ["#9BFFE4", "#7EE8FF", "#C9A7FF"], density: .8 } },

  { id: "midnight", name: "Midnight", group: "Night",
    font: "'Syne'", ink: "#EFEAFF", sub: "#B4A9E0", accent: "#FFD166",
    onAccent: "#20143A", chip: "rgba(255,255,255,.1)", card: "rgba(18,14,40,.44)",
    particles: { kind: "stars", colors: ["#FFFFFF", "#FFE9A8", "#B8C6FF"], density: 1 } },

  { id: "cosmic", name: "Cosmic", group: "Night",
    font: "'Space Grotesk'", ink: "#F1EAFF", sub: "#C0AEEA", accent: "#B388FF",
    onAccent: "#1A0B33", chip: "rgba(255,255,255,.1)", card: "rgba(24,12,44,.44)",
    particles: { kind: "stars", colors: ["#FFFFFF", "#C9A7FF", "#7EC8FF"], density: 1 } },

  { id: "rave", name: "Neon Rave", group: "Night",
    font: "'Unbounded'", ink: "#F2FBFF", sub: "#8FE9FF", accent: "#FF2E97",
    onAccent: "#fff", chip: "rgba(255,255,255,.08)", card: "rgba(10,4,24,.5)",
    particles: { kind: "sparkles", colors: ["#00E5FF", "#FF2E97", "#B14BFF", "#39FF88"], density: 1 } },

  { id: "disco", name: "Disco Ball", group: "Night",
    font: "'Righteous'", ink: "#FFF6E6", sub: "#E4C98A", accent: "#FFD24A",
    onAccent: "#2A1B00", chip: "rgba(255,255,255,.1)", card: "rgba(18,12,28,.46)",
    particles: { kind: "sparkles", colors: ["#FFD24A", "#FF8FD0", "#8FE1FF", "#FFFFFF"], density: 1.1 } },

  { id: "y2k", name: "Y2K Chrome", group: "Retro",
    font: "'VT323'", ink: "#0B2A5B", sub: "#3E6BA8", accent: "#2E7BFF",
    onAccent: "#fff", chip: "rgba(255,255,255,.55)", card: "rgba(255,255,255,.42)",
    particles: { kind: "sparkles", colors: ["#7FB2FF", "#C0D8FF", "#FFFFFF"], density: .9 } },

  { id: "retro", name: "Retro Sun", group: "Retro",
    font: "'Bungee'", ink: "#FFF0F6", sub: "#FFC0DD", accent: "#FF3D7F",
    onAccent: "#fff", chip: "rgba(0,0,0,.2)", card: "rgba(30,8,40,.36)",
    particles: { kind: "none" } }
];

export const THEME_BY_ID = Object.fromEntries(THEMES.map(t => [t.id, t]));
export const DEFAULT_THEME = "confetti";

export function themeOf(id) { return THEME_BY_ID[id] || THEME_BY_ID[DEFAULT_THEME]; }

// Apply a theme's palette + font to an element (the event surface) and set the
// background class. Does not start particles — call startParticles separately.
export function applyTheme(el, id) {
  const t = themeOf(id);
  THEMES.forEach(x => el.classList.remove("t-" + x.id));
  el.classList.add("ev-theme", "t-" + t.id);
  el.style.setProperty("--th-font", t.font + ", system-ui, sans-serif");
  el.style.setProperty("--th-ink", t.ink);
  el.style.setProperty("--th-sub", t.sub);
  el.style.setProperty("--th-accent", t.accent);
  el.style.setProperty("--th-on-accent", t.onAccent);
  el.style.setProperty("--th-chip", t.chip);
  el.style.setProperty("--th-card", t.card);
  return t;
}

const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Particle engine. Returns a stop() that cancels the animation and clears.
export function startParticles(canvas, id) {
  const t = themeOf(id);
  const spec = t.particles || { kind: "none" };
  if (!canvas || spec.kind === "none") return () => {};
  const ctx = canvas.getContext("2d");
  let raf = 0, W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2), parts = [], running = true;
  const colors = spec.colors || ["#fff"];
  const dens = spec.density || 1;
  const pick = () => colors[(Math.random() * colors.length) | 0];

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }
  function count() {
    const base = { confetti: 70, petals: 34, stars: 90, bubbles: 26, sparkles: 60, embers: 40 }[spec.kind] || 40;
    return Math.round(Math.min(base, (W * H) / 9000) * dens);
  }
  function make() {
    const c = pick();
    if (spec.kind === "confetti")
      return { x: Math.random() * W, y: Math.random() * -H, w: 5 + Math.random() * 6, h: 8 + Math.random() * 7,
        vy: 30 + Math.random() * 55, vx: -18 + Math.random() * 36, rot: Math.random() * 6.28, vr: -3 + Math.random() * 6, c };
    if (spec.kind === "petals")
      return { x: Math.random() * W, y: Math.random() * -H, r: 6 + Math.random() * 7, vy: 18 + Math.random() * 26,
        sway: 12 + Math.random() * 22, ph: Math.random() * 6.28, spd: .6 + Math.random(), rot: Math.random() * 6.28, c };
    if (spec.kind === "bubbles")
      return { x: Math.random() * W, y: H + Math.random() * H, r: 5 + Math.random() * 16, vy: 14 + Math.random() * 26,
        sway: 8 + Math.random() * 20, ph: Math.random() * 6.28, c };
    if (spec.kind === "embers")
      return { x: Math.random() * W, y: H + Math.random() * H, r: 1.5 + Math.random() * 2.5, vy: 12 + Math.random() * 22,
        sway: 6 + Math.random() * 14, ph: Math.random() * 6.28, life: Math.random(), c };
    if (spec.kind === "sparkles")
      return { x: Math.random() * W, y: Math.random() * H, r: 1 + Math.random() * 2.5, ph: Math.random() * 6.28,
        spd: 1 + Math.random() * 2, c };
    // stars
    return { x: Math.random() * W, y: Math.random() * H, r: .6 + Math.random() * 1.8, ph: Math.random() * 6.28,
      spd: .6 + Math.random() * 1.6, c };
  }
  function seed() { parts = Array.from({ length: count() }, make); }

  let last = performance.now();
  function frame(now) {
    if (!running) return;
    const dt = Math.min((now - last) / 1000, .05); last = now;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      if (spec.kind === "confetti") {
        p.y += p.vy * dt; p.x += p.vx * dt; p.rot += p.vr * dt;
        if (p.y > H + 20) { p.y = -20; p.x = Math.random() * W; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c; ctx.globalAlpha = .9;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      } else if (spec.kind === "petals") {
        p.ph += p.spd * dt; p.y += p.vy * dt; p.x += Math.sin(p.ph) * p.sway * dt; p.rot += dt;
        if (p.y > H + 20) { p.y = -20; p.x = Math.random() * W; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c; ctx.globalAlpha = .85;
        ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * .6, 0, 0, 6.28); ctx.fill(); ctx.restore();
      } else if (spec.kind === "bubbles") {
        p.ph += dt; p.y -= p.vy * dt; p.x += Math.sin(p.ph) * p.sway * dt;
        if (p.y < -30) { p.y = H + 30; p.x = Math.random() * W; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28);
        ctx.fillStyle = p.c; ctx.globalAlpha = .28; ctx.fill();
        ctx.globalAlpha = .5; ctx.lineWidth = 1; ctx.strokeStyle = p.c; ctx.stroke();
      } else if (spec.kind === "embers") {
        p.ph += dt; p.y -= p.vy * dt; p.x += Math.sin(p.ph) * p.sway * dt; p.life += dt * .4;
        if (p.y < -20) { p.y = H + 20; p.x = Math.random() * W; p.life = 0; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28);
        ctx.fillStyle = p.c; ctx.globalAlpha = .5 + .5 * Math.sin(p.life * 3); ctx.shadowBlur = 8; ctx.shadowColor = p.c;
        ctx.fill(); ctx.shadowBlur = 0;
      } else if (spec.kind === "sparkles") {
        p.ph += p.spd * dt;
        const a = Math.max(0, Math.sin(p.ph));
        if (a < .02 && Math.random() < .05) { p.x = Math.random() * W; p.y = Math.random() * H; }
        const s = p.r * (1 + a * 2);
        ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = p.c; ctx.lineWidth = 1.4; ctx.beginPath();
        ctx.moveTo(p.x - s, p.y); ctx.lineTo(p.x + s, p.y); ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x, p.y + s);
        ctx.stroke(); ctx.restore();
      } else { // stars
        p.ph += p.spd * dt;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28);
        ctx.fillStyle = p.c; ctx.globalAlpha = .4 + .6 * (0.5 + 0.5 * Math.sin(p.ph)); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  resize();
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  if (REDUCED) {
    // Draw a single static frame so thumbnails and reduced-motion users still
    // get the texture, without an animation loop.
    running = false; last = performance.now(); const r = running; running = true; frame(performance.now()); running = false;
  } else {
    raf = requestAnimationFrame(frame);
  }
  return () => { running = false; cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); ctx && ctx.clearRect(0, 0, W, H); };
}
