// Blip, Friendly's mascot. Two things live here:
//   Blip.svg({mood,size,still})  -> markup for a small Blip (empty states, banners, tips)
//   Blip.morph(svgEl, opts)      -> the origin animation: the wordmark flows into Blip
// Blip is the wordmark's yellow dot grown into a lopsided pebble; its cheeks are the
// coral "l" split in two; tall oval eyes. Everything in the morph is computed each
// frame from one progress value so nothing pops or fades. Plain script, no imports.
(function () {
  const SUN = "#FFC145", CORAL = "#FF6B57", CHEEK = "#FF8C50", INK = "#2A2019";
  // Six-node cubic loops (radius ~10 around 0,0) so the circle can morph into the pebble.
  const SHAPES = {
    circle: "M0,-10 C3.573,-10 6.873,-8.094 8.66,-5 C10.447,-1.906 10.447,1.906 8.66,5 C6.873,8.094 3.573,10 0,10 C-3.573,10 -6.873,8.094 -8.66,5 C-10.447,1.906 -10.447,-1.906 -8.66,-5 C-6.873,-8.094 -3.573,-10 0,-10 Z",
    pebble: "M-1.5,-10.2 C2.5,-11 6.5,-9 8.2,-6.5 C10,-4 11,1 10.2,4.5 C9.4,8 6,11 1,10.6 C-3.5,10.2 -6,9.5 -8,7.5 C-10.2,5.3 -11,0 -10.4,-3.5 C-9.8,-7 -5.5,-9.6 -1.5,-10.2 Z"
  };
  const stroke = (d, w = 3) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const grin = (cx, cy, w = 11, h = 14) => `<path d="M${cx - w} ${cy} Q${cx} ${cy + h} ${cx + w} ${cy} Z" fill="${INK}"/>`;
  const arcEye = (x, y, w = 6) => stroke(`M${x - w} ${y + 1} Q${x} ${y - 6} ${x + w} ${y + 1}`, 3.6);

  // The face: tall oval eyes with a glint, a single stroke mouth.
  function face(mood, cx, cy) {
    const y = cy - 3;
    const eye = (x, dx = 0, dy = 0, ry = 5.8) => `<g class="eye"><ellipse cx="${x + dx}" cy="${y + dy}" rx="3.7" ry="${ry}" fill="${INK}"/><circle cx="${x + dx + 1.3}" cy="${y + dy - 2.4}" r="1.3" fill="#fff"/></g>`;
    const purse = stroke(`M${cx + 3} ${cy + 11.5} q3 -2 6.5 -1`, 2.8);
    switch (mood) {
      case "happy": return arcEye(cx - 12, y) + arcEye(cx + 12, y) + grin(cx, cy + 8, 10, 13);
      case "thinking": return `<g class="look">${eye(cx - 12, 2.5, -4.5, 5.4)}${eye(cx + 12, 2.5, -4.5, 5.4)}</g>` + purse;
      case "oops": return eye(cx - 12, 0, 0, 6.6) + eye(cx + 12, 0, 0, 6.6) + `<circle cx="${cx}" cy="${cy + 12}" r="3.2" fill="none" stroke="${INK}" stroke-width="2.6"/><path class="sweat" d="M${cx + 30} ${cy - 14} q4 6 0 10 q-4 -4 0 -10z" fill="#3B82F6"/>`;
      case "party": return eye(cx - 12, 0, -1, 6.6) + eye(cx + 12, 0, -1, 6.6) + grin(cx, cy + 7, 13, 18) + `<path d="M${cx - 7} ${cy + 13} Q${cx} ${cy + 19} ${cx + 7} ${cy + 13}" fill="${CORAL}"/>`;
      case "sleepy": return stroke(`M${cx - 16} ${y + 1} h8`, 3.4) + stroke(`M${cx + 8} ${y + 1} h8`, 3.4) + stroke(`M${cx - 5} ${cy + 10} Q${cx} ${cy + 13} ${cx + 5} ${cy + 10}`) + `<g class="zz" font-family="Bricolage Grotesque,system-ui" font-weight="700" fill="${INK}"><text x="${cx + 30}" y="${cy - 26}" font-size="14">z</text><text x="${cx + 40}" y="${cy - 38}" font-size="10">z</text></g>`;
      default: return eye(cx - 12) + eye(cx + 12) + stroke(`M${cx - 7} ${cy + 10} Q${cx} ${cy + 15} ${cx + 7} ${cy + 10}`);
    }
  }
  const confetti = (cx, cy) => `<g class="conf">` + [[CORAL, -38, -30], ["#25A56A", 34, -34], ["#3B82F6", -30, 26], [SUN, 40, 22], [CORAL, 0, -46], ["#25A56A", 44, -6]]
    .map(([c, dx, dy]) => `<rect x="${cx - 3}" y="${cy - 4}" width="6" height="8" rx="1.5" fill="${c}" style="--dx:${dx}px;--dy:${dy}px"/>`).join("") + `</g>`;

  function svg({ mood = "idle", size = 96, still = false } = {}) {
    const cx = 60, cy = 56, glow = (mood === "happy" || mood === "party") ? .78 : .6;
    const body = `<path transform="translate(${cx} ${cy}) scale(4.2)" d="${SHAPES.pebble}" fill="${SUN}"/>
      <ellipse cx="${cx - 17}" cy="${cy - 21}" rx="9" ry="5" fill="#fff" opacity=".45" transform="rotate(-35 ${cx - 17} ${cy - 21})"/>
      <circle cx="${cx - 23}" cy="${cy + 8}" r="5.2" fill="${CORAL}" opacity="${glow}"/><circle cx="${cx + 23}" cy="${cy + 8}" r="5.2" fill="${CORAL}" opacity="${glow}"/>`;
    return `<svg viewBox="-4 -8 128 132" width="${size}" height="${size}" class="blip ${still ? "" : "idle"} blip-${mood}" aria-hidden="true">${mood === "party" ? confetti(cx, cy) : ""}<g transform="${mood === "thinking" ? `rotate(-7 ${cx} ${cy + 42})` : ""}"><g class="body">${body}${face(mood, cx, cy)}</g></g></svg>`;
  }

  // ---- the origin morph -----------------------------------------------------------
  const rot = (x, y, deg) => { const a = deg * Math.PI / 180; return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]; };
  const nums = d => d.match(/-?\d+(\.\d+)?/g).map(Number);
  const CIRC = nums(SHAPES.circle), PEB = nums(SHAPES.pebble), TPL = SHAPES.circle.split(/-?\d+(?:\.\d+)?/);
  const shapeAt = k => TPL.map((t, j) => j < CIRC.length ? t + (CIRC[j] + (PEB[j] - CIRC[j]) * k).toFixed(3) : t).join("");
  const clamp = x => x < 0 ? 0 : x > 1 ? 1 : x, lerp = (a, b, k) => a + (b - a) * k;
  const io = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const ei = x => x * x * x;
  const ob = x => { const c = 1.4; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const cubic = (A, B, C, D, k) => { const m = 1 - k; return [m * m * m * A[0] + 3 * m * m * k * B[0] + 3 * m * k * k * C[0] + k * k * k * D[0], m * m * m * A[1] + 3 * m * m * k * B[1] + 3 * m * k * k * C[1] + k * k * k * D[1]]; };
  const S0 = 8.4, CORAL_RGB = [255, 107, 87], CHEEK_RGB = [255, 140, 80];
  const mix = (a, b, k) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], k))).join(",")})`;
  let uid = 0;

  // svgEl gets viewBox 0 0 720 300. opts.ink = wordmark color (white on the splash).
  // Returns {layout, draw(p, t)}: p 0 = wordmark, 1 = Blip; t = seconds, for idle motion.
  function morph(svgEl, opts = {}) {
    const id = ++uid, ink = opts.ink || INK;
    svgEl.setAttribute("viewBox", "0 0 720 300");
    svgEl.innerHTML = `<defs><filter id="goo${id}" filterUnits="userSpaceOnUse" x="-80" y="-80" width="880" height="460" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="b"/>
        <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 28 -12" result="g"/>
        <feComposite in="SourceGraphic" in2="g" operator="atop"/></filter></defs>
      <g class="wm" fill="${ink}"><text class="tF" x="60" y="190">Friend</text><text class="tY" x="0" y="190">y</text></g>
      <g filter="url(#goo${id})"><path class="body" fill="${SUN}"/><rect class="d1" fill="${CORAL}"/><rect class="d2" fill="${CORAL}"/></g>
      <text class="tL" x="0" y="190" opacity="0" fill="${CORAL}">l</text>
      <rect class="o1" fill="${CORAL}"/><rect class="o2" fill="${CORAL}"/>
      <circle class="dot0" r="10" fill="${SUN}"/>
      <ellipse class="hl" fill="#fff" opacity="0"/>
      <g class="eyeL"><ellipse rx="7.4" ry="11.6" fill="${INK}"/><circle cx="2.6" cy="-4.8" r="2.6" fill="#fff"/></g>
      <g class="eyeR"><ellipse rx="7.4" ry="11.6" fill="${INK}"/><circle cx="2.6" cy="-4.8" r="2.6" fill="#fff"/></g>
      <path class="mouth" d="M-14 20 Q0 30 14 20" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;
    svgEl.querySelectorAll("text").forEach(t => { t.style.fontFamily = '"Bricolage Grotesque","Avenir Next",system-ui,sans-serif'; t.style.fontWeight = "700"; t.style.fontSize = "112px"; t.style.letterSpacing = "-4px"; });
    const q = c => svgEl.querySelector("." + c);
    const tF = q("tF"), tY = q("tY"), tL = q("tL"), wm = q("wm"), body = q("body"), d1 = q("d1"), d2 = q("d2"), o1 = q("o1"), o2 = q("o2"), dot0 = q("dot0"), hl = q("hl"), eyeL = q("eyeL"), eyeR = q("eyeR"), mouth = q("mouth");
    const mouthLen = mouth.getTotalLength(); mouth.setAttribute("stroke-dasharray", mouthLen);
    let G = null;
    function layout() {
      const fx = 60, wF = tF.getComputedTextLength(), wL = tL.getComputedTextLength(), wY = tY.getComputedTextLength();
      const lx = fx + wF + 8, yx = lx + wL + 1; tL.setAttribute("x", lx); tY.setAttribute("x", yx);
      const dx = yx + wY + 12, dy = 98, bx = Math.round((fx + dx) / 2), by = 150;
      // the l's ink (not its layout box), measured from the same font on a canvas
      const b = tL.getBBox(); let inkL = b.x, inkR = b.x + b.width, inkT = b.y, inkB = 190;
      try {
        const c = document.createElement("canvas").getContext("2d"); c.font = "700 112px " + getComputedStyle(tL).fontFamily;
        const m = c.measureText("l");
        if (m.actualBoundingBoxAscent) { inkL = lx - m.actualBoundingBoxLeft; inkR = lx + m.actualBoundingBoxRight; inkT = 190 - m.actualBoundingBoxAscent; inkB = 190 + m.actualBoundingBoxDescent; }
      } catch (e) {}
      const P = [(inkL + inkR) / 2, inkB];
      tL.setAttribute("transform", `rotate(-9 ${P[0]} ${P[1]})`);
      G = { dx, dy, bx, by, P, u: rot(0, -1, -9), v: rot(1, 0, -9), w: inkR - inkL, h: inkB - inkT };
    }
    const loc = (a, c) => [G.P[0] + G.u[0] * a + G.v[0] * c, G.P[1] + G.u[1] * a + G.v[1] * c];
    function drop(el, ov, half, p, at, kx) {
      const W = (a, b) => clamp((p - a) / (b - a));
      const w = G.w, h = G.h, mid = h / 2;
      const round = io(W(.02, .30)), len = lerp(h / 2, w, io(W(.08, .40)));
      const rc = W(.34, .46), gap = io(W(.06, .26)) * 3 + ei(W(.24, .40)) * 34 + (ob(rc) - rc) * 10;
      const S = loc(mid + half * (gap + len / 2), 0);
      const e = io(W(half > 0 ? .36 : .38, half > 0 ? .80 : .82));
      const T = at(half > 0 ? -44 : 44, 16);
      const c1 = half > 0 ? [S[0] - 70, S[1] - 150] : [S[0] + 40, S[1] + 110], c2 = half > 0 ? [T[0] - 120, T[1] - 50] : [T[0] + 130, T[1] + 40];
      const Pt = cubic(S, c1, c2, T, e), Pn = cubic(S, c1, c2, T, Math.min(1, e + .01));
      const vx = Pn[0] - Pt[0], vy = Pn[1] - Pt[1], sp = Math.hypot(vx, vy), th = Math.atan2(vy, vx);
      const land = Math.sin(Math.PI * W(.78, .94));
      const sv = Math.min(.42, sp / 9) * io(clamp(e * 6)) * (1 - W(.74, .82)) - .28 * land;
      const c = Math.cos(th), sn = Math.sin(th), ma = c * c * (1 + sv) + sn * sn * (1 - .6 * sv), mb = c * sn * 1.6 * sv, md = sn * sn * (1 + sv) + c * c * (1 - .6 * sv);
      const size = lerp(w, 19 * kx, e), ht = lerp(len, size, e);
      for (const r of [el, ov]) {
        r.setAttribute("width", size); r.setAttribute("height", ht); r.setAttribute("x", -size / 2); r.setAttribute("y", -ht / 2); r.setAttribute("rx", (size / 2) * round);
        r.setAttribute("transform", `translate(${Pt[0]} ${Pt[1]}) matrix(${ma} ${mb} ${mb} ${md} 0 0) rotate(-9)`);
      }
      el.setAttribute("fill", mix(CORAL_RGB, CHEEK_RGB, W(.78, .92)));
      ov.setAttribute("opacity", 1 - W(.02, .10));
    }
    function draw(p, t) {
      if (!G) return;
      const W = (a, b) => clamp((p - a) / (b - a));
      wm.setAttribute("opacity", 1 - W(0, .3));
      const em = io(W(0, .55)), mq = 1 - em, s = lerp(1, S0, ob(W(.3, .78)));
      const cx = mq * mq * G.dx + 2 * mq * em * ((G.dx + G.bx) / 2) + em * em * G.bx, cy = mq * mq * G.dy + 2 * mq * em * (G.dy - 115) + em * em * G.by;
      const amp = W(.92, 1), sq = Math.sin(Math.PI * W(.78, .96)) * 0.07, br = Math.sin(t * 2 * Math.PI / 2.8) * 0.03 * amp;
      const sx = 1 + sq + br, sy = 1 - sq - br;
      body.setAttribute("d", shapeAt(io(W(.36, .8))));
      body.setAttribute("transform", `translate(${cx} ${cy + 10 * s}) scale(${s * sx} ${s * sy}) translate(0 -10)`);
      dot0.setAttribute("cx", cx); dot0.setAttribute("cy", cy); dot0.setAttribute("r", 10 * s); dot0.setAttribute("opacity", 1 - W(.28, .4));
      const ecx = cx, ecy = cy + 10 * s - 10 * s * sy, kx = s * sx / S0, ky = s * sy / S0;
      const at = (ox, oy) => [ecx + ox * kx, ecy + oy * ky];
      drop(d1, o1, +1, p, at, kx); drop(d2, o2, -1, p, at, kx);
      const hq = at(-34, -40); hl.setAttribute("cx", hq[0]); hl.setAttribute("cy", hq[1]); hl.setAttribute("rx", 18 * kx); hl.setAttribute("ry", 10 * ky);
      hl.setAttribute("transform", `rotate(-35 ${hq[0]} ${hq[1]})`); hl.setAttribute("opacity", .45 * W(.7, .9));
      const bt = t % 3.7, bl = bt > 3.42 && bt < 3.62 ? 1 - Math.abs((bt - 3.52) / .1) : 0;
      const ek = ob(W(.72, .94)), eyY = Math.max(.06, 1 - .94 * bl * amp);
      const L = at(-24, -6), R = at(24, -6);
      eyeL.setAttribute("transform", `translate(${L[0]} ${L[1]}) scale(${ek * kx} ${ek * ky * eyY})`);
      eyeR.setAttribute("transform", `translate(${R[0]} ${R[1]}) scale(${ek * kx} ${ek * ky * eyY})`);
      const m = at(0, 0); mouth.setAttribute("transform", `translate(${m[0]} ${m[1]}) scale(${kx} ${ky})`);
      mouth.setAttribute("stroke-dashoffset", mouthLen * (1 - io(W(.8, .99)))); mouth.setAttribute("opacity", W(.8, .83));
    }
    return { layout, draw };
  }

  // Play the origin story once inside svgEl (wordmark -> Blip over `dur` seconds), then idle.
  // Returns a stop() function. Waits briefly for the display font so the wordmark measures right.
  function play(svgEl, { dur = 1.9, delay = .25, ink = "#fff" } = {}) {
    let stopped = false, raf = 0;
    const m = morph(svgEl, { ink });
    const start = () => {
      if (stopped) return;
      m.layout();
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) { m.draw(1, 0); return; }
      let t0 = null;
      const tick = now => {
        if (stopped) return;
        if (t0 === null) t0 = now;
        const t = (now - t0) / 1000, p = clamp((t - delay) / dur);
        m.draw(p, t);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const fontReady = document.fonts && document.fonts.load ? Promise.race([document.fonts.load('700 112px "Bricolage Grotesque"'), new Promise(r => setTimeout(r, 700))]) : Promise.resolve();
    fontReady.then(start, start);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }

  window.Blip = { svg, morph, play, SHAPES };
})();
