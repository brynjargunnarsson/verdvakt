// Verðlínurit: skreflína (verð helst óbreytt þar til það breytist), ein lína á verslun
// og „besta verð“ sem breiður skuggi bak við. Engin utanaðkomandi bókasöfn.
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
};
const htmlEl = (tag, attrs = {}, text) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text; // heiti koma úr gögnum: aldrei innerHTML
  return n;
};

const HOUR = 3600e3;
const DAY = 24 * HOUR;

function niceTicks(min, max, count = 4) {
  if (max - min < max * 0.02) {
    min = max * 0.95;
    max = max * 1.05;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v));
  return out;
}

function timeTicks(t0, t1) {
  const span = t1 - t0;
  const out = [];
  if (span <= 36 * HOUR) {
    for (let t = Math.ceil(t0 / (6 * HOUR)) * 6 * HOUR; t <= t1; t += 6 * HOUR) out.push({ t, time: true });
  } else {
    const step = Math.max(1, Math.ceil(span / DAY / 6)) * DAY;
    for (let t = Math.ceil(t0 / DAY) * DAY; t <= t1; t += step) out.push({ t, time: false });
  }
  return out;
}

const valueAt = (pts, t) => {
  let v = null;
  for (const [ts, val] of pts) {
    if (ts <= t) v = val;
    else break;
  }
  return v;
};

/**
 * root: tómur gámur. o = { series:[{key,name,color,pts:[[ms,verð]]}], best:[[ms,verð]]|null,
 *   t0, t1, hidden:Set, onToggle(key), fmt:{kr, day, when, time}, label }
 */
export function drawPriceChart(root, o) {
  root.textContent = '';
  const { series, best, hidden, onToggle, fmt } = o;
  const t1 = o.t1;
  const t0 = Math.min(o.t0, t1 - 6 * HOUR);
  const all = best ? [{ key: 'best', name: 'Besta verð', color: 'var(--ink)', pts: best, kind: 'best' }, ...series] : series;
  const vis = all.filter((s) => !hidden.has(s.key));

  if (all.length > 1) {
    const legend = htmlEl('div', { class: 'cl-legend' });
    for (const s of all) {
      const on = !hidden.has(s.key);
      const b = htmlEl('button', { type: 'button', class: 'cl-key', 'aria-pressed': String(on), title: on ? 'Smelltu til að fela línuna' : 'Smelltu til að sýna línuna' });
      const sw = htmlEl('span', { class: 'cl-sw' + (s.kind === 'best' ? ' best' : '') });
      sw.style.setProperty('--c', s.color);
      b.append(sw, document.createTextNode(s.name));
      b.addEventListener('click', () => onToggle(s.key));
      legend.append(b);
    }
    root.append(legend);
  }

  const W = Math.max(320, Math.floor(root.clientWidth || 640));
  const H = 280;
  const wide = W >= 560;
  const m = { l: 74, r: wide ? 84 : 16, t: 14, b: 30 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;

  const src = vis.length ? vis : all;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of src) for (const [, v] of s.pts) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  const yt = niceTicks(lo, hi);
  const yLo = yt[0];
  const yHi = yt[yt.length - 1];
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * pw;
  const Y = (v) => m.t + (1 - (v - yLo) / (yHi - yLo)) * ph;

  const wrap = htmlEl('div', { class: 'cl-wrap' });
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: 0, class: 'cl-svg', 'aria-label': o.label || 'Verðsaga' });

  for (const v of yt) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'cl-grid' }, svg);
    svgEl('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'cl-tick' }, svg).textContent = fmt.num(v);
  }
  for (const { t, time } of timeTicks(t0, t1)) {
    const x = X(t);
    if (x < m.l + 14 || x > W - m.r - 14) continue;
    svgEl('text', { x, y: H - 8, 'text-anchor': 'middle', class: 'cl-tick' }, svg).textContent = time ? fmt.time(t) : fmt.day(t);
  }

  const stepPath = (pts) => {
    let d = `M${X(Math.max(pts[0][0], t0))} ${Y(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += `H${X(pts[i][0])}V${Y(pts[i][1])}`;
    return d + `H${X(t1)}`;
  };

  for (const s of vis) {
    if (s.kind === 'best') {
      const p = svgEl('path', { d: stepPath(s.pts), class: 'cl-best' }, svg);
      p.style.stroke = 'var(--ink)';
    }
  }
  for (const s of vis) {
    if (s.kind === 'best') continue;
    const p = svgEl('path', { d: stepPath(s.pts), class: 'cl-line' }, svg);
    p.style.stroke = s.color;
  }
  for (const s of vis) {
    if (s.kind === 'best') continue;
    if (s.pts.length <= 40) {
      for (const [t, v] of s.pts) {
        const c = svgEl('circle', { cx: X(Math.max(t, t0)), cy: Y(v), r: 4, class: 'cl-dot' }, svg);
        c.style.fill = s.color;
      }
    }
    const last = s.pts[s.pts.length - 1][1];
    const c = svgEl('circle', { cx: X(t1), cy: Y(last), r: 4, class: 'cl-dot' }, svg);
    c.style.fill = s.color;
  }

  // Gildi við enda línunnar – sleppt ef þau rekast á (þá bera skýringin og músarvísirinn gildin).
  if (wide) {
    const ends = vis
      .filter((s) => s.kind !== 'best')
      .map((s) => ({ s, v: s.pts[s.pts.length - 1][1] }))
      .sort((a, b) => a.v - b.v);
    const ok = ends.length <= 4 && ends.every((e, i) => i === 0 || Math.abs(Y(e.v) - Y(ends[i - 1].v)) >= 15);
    if (ok) for (const e of ends) svgEl('text', { x: X(t1) + 10, y: Y(e.v) + 4, class: 'cl-end' }, svg).textContent = fmt.kr(e.v);
  }

  // Músarvísir
  const cross = svgEl('line', { y1: m.t, y2: m.t + ph, class: 'cl-cross', visibility: 'hidden' }, svg);
  const dots = svgEl('g', {}, svg);
  const tip = htmlEl('div', { class: 'cl-tip', hidden: '' });
  const hit = svgEl('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', class: 'cl-hit' }, svg);

  const show = (t) => {
    t = Math.min(t1, Math.max(t0, t));
    const x = X(t);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('visibility', 'visible');
    dots.textContent = '';
    tip.textContent = '';
    tip.append(htmlEl('div', { class: 'cl-tip-h' }, fmt.when(t)));
    let rows = 0;
    for (const s of vis) {
      const v = valueAt(s.pts, t);
      if (v == null) continue;
      rows++;
      if (s.kind !== 'best') {
        const d = svgEl('circle', { cx: x, cy: Y(v), r: 5, class: 'cl-dot' }, dots);
        d.style.fill = s.color;
      }
      const row = htmlEl('div', { class: 'cl-tip-r' });
      const k = htmlEl('span', { class: 'cl-sw' + (s.kind === 'best' ? ' best' : '') });
      k.style.setProperty('--c', s.color);
      row.append(k, htmlEl('b', {}, fmt.kr(v)), htmlEl('span', { class: 'cl-tip-n' }, s.name));
      tip.append(row);
    }
    if (!rows) tip.append(htmlEl('div', { class: 'cl-tip-n' }, 'Vöktun hófst síðar'));
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = (x + 14 + tw > W ? x - 14 - tw : x + 14) + 'px';
    tip.style.top = m.t + 4 + 'px';
    show.t = t;
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.textContent = '';
    tip.hidden = true;
    show.t = null;
  };
  const atPointer = (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    show(t0 + ((x - m.l) / pw) * (t1 - t0));
  };
  hit.addEventListener('pointermove', atPointer);
  hit.addEventListener('pointerdown', atPointer);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('keydown', (e) => {
    const step = (t1 - t0) / 40;
    if (e.key === 'ArrowLeft') show((show.t ?? t1) - step);
    else if (e.key === 'ArrowRight') show((show.t ?? t0) + step);
    else if (e.key === 'Home') show(t0);
    else if (e.key === 'End') show(t1);
    else if (e.key === 'Escape') hide();
    else return;
    e.preventDefault();
  });
  svg.addEventListener('blur', hide);

  wrap.append(svg, tip);
  root.append(wrap);
}
