/* PeakSurf /next/ — Ocean tab (lazy: maps.js loads it after Leaflet).

   Data (scripts/export_ibi_wave_grid.py → data/ocean/, README §2):
     latest.json          manifest: run id, grid, encodings, 3-hourly frames
     <run>/hNNN_hs.png    Hs at 1/36°, grey; code c → (c/254)²·20 m, 255 = land
     <run>/hNNN_td.png    grey, 1/18°: Tp rows (code·0.2 s, 0 = none) then
                          direction-from rows (code·360/128)
     <run>/summary.png    R/G = per-cell p05/p95 Hs over the run, B = km to coast/4
   First paint = manifest + one frame pair (~140 KB); later frames load on
   demand and the service worker keeps them per run.

   Rendering is Canvas 2D (no WebGL):
     field  bilinear in space, linear in time, colour LUT, model land mask with
            a 1-px anti-aliased edge; banded style adds thin isolines.
     flow   particles along the wave travel direction (VMDR + 180°), speed from
            the peak period, fading trails. Static streamlines when the user
            prefers reduced motion; paused when hidden or scrolled away. */
'use strict';

const Ocean = (() => {
    /* ================= colour scales ================= */
    // Eight colours per palette = eight bands. Checked with the dataviz
    // validator (OKLab ΔE×100 between adjacent bands, Machado CVD simulation):
    //   ocean  normal ≥ 12.7, protan/deutan ≥ 11.2 — blue → teal → yellow → orange → magenta
    //   deep   normal ≥ 10.5, CVD ≥ 8.6 — viridis-like, lightness rises monotonically
    //   period normal ≥ 10.9, CVD ≥ 6.1 (+ isolines and labelled ticks)
    const PALETTES = {
        ocean: ['#2c2c74', '#0156a4', '#0182b0', '#0dadb4', '#4cd697', '#e5e12f', '#fe973b', '#eb3e94'],
        deep: ['#3c236b', '#2a4a9d', '#0179a3', '#009ea2', '#0ec193', '#6fda75', '#ffe037', '#fff7d9'],
        period: ['#28236a', '#632895', '#af268e', '#e04667', '#f67742', '#ffa53b', '#fcd241', '#f5f8a9'],
    };
    // ↓ The default look — a one-line change. (URL knobs for comparing:
    //   ?ocPalette=ocean|deep  &ocBands=1|0  &ocScale=fixed|auto)
    const DEFAULT_STYLE = { palette: 'ocean', banded: true, scale: 'fixed' };
    // Fixed scales: identical for every frame and run, so days compare.
    const HS_BOUNDS = [0, 0.5, 1, 1.5, 2, 3, 4, 6, 8];      // <0.5 · 0.5–1 · … · 4–6 · 6+
    const TP_BOUNDS = [4, 6, 8, 10, 12, 14, 16, 18, 20];    // 2-s bands, 8–16 s mid-palette

    const SCALE_KEY = 'peaksurf_ocean_scale';
    const STALE_MS = 30 * 3600000, CRITICAL_MS = 48 * 3600000;
    const PLAY_HOURS_PER_S = 5;          // 7 days in ~34 s
    const FLOW_CELL = 6;                 // px, particle velocity grid
    const TRAIL = 10;                    // positions kept per particle
    const MAX_DECODED = 14;              // decoded frames kept in memory
    const LUT_SUB = 4;                   // colour LUT steps per code
    const IBI_VIEW = [[27, -17], [55, 3]];

    const style = (() => {
        const q = new URLSearchParams(location.search);
        const s = Object.assign({}, DEFAULT_STYLE);
        if (PALETTES[q.get('ocPalette')] && q.get('ocPalette') !== 'period') s.palette = q.get('ocPalette');
        if (q.has('ocBands')) s.banded = q.get('ocBands') !== '0';
        const stored = storeGet(SCALE_KEY);
        if (stored === 'auto' || stored === 'fixed') s.scale = stored;
        if (q.get('ocScale') === 'auto' || q.get('ocScale') === 'fixed') s.scale = q.get('ocScale');
        return s;
    })();

    /* ================= state ================= */
    let map = null, field = null, flow = null, markerLayer = null, probeMarker = null;
    let man = null, manPromise = null, frameTimes = [];
    let summary = null, summaryPromise = null, autoRange = null;
    let layer = 'hs', flowOn = true, windOn = false;
    let T = null;                        // displayed time, epoch ms (fractional hours allowed)
    let selected = null, probe = null;
    let playing = false, moving = false, inView = true;
    let rafId = 0, lastTs = 0, lastFieldTs = 0, lastUiTs = 0, settleTimer = 0;
    let reducedMotion = false;
    let lut = null;                      // {key, colors: Uint32Array, bands: Uint8Array, scale}
    const spotMarkers = new Map();
    let markerStep = null;

    const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    /* ================= scales & LUTs ================= */
    function paletteRgb(name) { return PALETTES[name].map(hexRgb); }
    /** Colour at palette position p ∈ [0,1]; colours sit at band centres. */
    function paletteAt(rgbs, p) {
        const n = rgbs.length, x = clamp(p, 0, 1) * n - 0.5;
        if (x <= 0) return rgbs[0];
        if (x >= n - 1) return rgbs[n - 1];
        const i = Math.floor(x), f = x - i, a = rgbs[i], b = rgbs[i + 1];
        return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f));
    }
    /** Auto-contrast bands: ~8 boundaries between lo and hi, evenly spaced
        in sqrt(Hs) (more room for small waves), snapped to readable values. */
    function autoBounds(lo, hi) {
        const step = v => v < 1 ? 0.1 : v < 2.4 ? 0.2 : v < 5 ? 0.5 : v < 10 ? 1 : 2;
        const snap = (v, how) => { const k = step(v); return Math.round(Math[how](v / k + (how === 'floor' ? 1e-6 : how === 'ceil' ? -1e-6 : 0)) * k * 100) / 100; };
        lo = Math.max(0, lo);
        hi = Math.max(hi, lo + 0.6);
        const a = snap(lo, 'floor'), b = snap(hi, 'ceil');
        const s0 = Math.sqrt(a), s1 = Math.sqrt(b), bounds = [a];
        for (let k = 1; k < 8; k++) {
            const v = snap((s0 + (s1 - s0) * k / 8) ** 2, 'round');
            if (v > bounds[bounds.length - 1] + 1e-9 && v < b - 1e-9) bounds.push(v);
        }
        bounds.push(b);
        return { lo: a, hi: b, bounds };
    }
    /** The active scale for a layer: bounds, value→position, band colours. */
    function scaleFor(which) {
        if (which === 'tp') return makeScale('fixed', TP_BOUNDS, 'period', 's');
        if (style.scale === 'auto' && autoRange) return makeScale('auto', autoRange.bounds, style.palette, 'm');
        return makeScale('fixed', HS_BOUNDS, style.palette, 'm');
    }
    /** Bands have equal width on the legend and on the colour ramp; values are
        linear inside a band. The fixed Hs bounds are already non-linear, the
        auto bounds are sqrt-spaced, so both stretch the small-wave range. */
    function makeScale(mode, bounds, palette, unit) {
        const n = bounds.length - 1, lo = bounds[0], hi = bounds[n];
        const pos = v => {
            if (!(v > lo)) return 0;
            if (v >= hi) return 1;
            let k = 1;
            while (k < n && v > bounds[k]) k++;
            return (k - 1 + (v - bounds[k - 1]) / (bounds[k] - bounds[k - 1])) / n;
        };
        const rgbs = paletteRgb(palette);
        const bandRgb = [];
        for (let k = 0; k < n; k++) bandRgb.push(n === rgbs.length ? rgbs[k] : paletteAt(rgbs, (k + 0.5) / n));
        const band = v => { let k = 0; while (k < n - 1 && v >= bounds[k + 1]) k++; return k; };
        return { mode, bounds, pos, band, bandRgb, rgbs, unit, banded: style.banded, key: [mode, bounds.join(','), palette, style.banded].join('|') };
    }
    function decodeHsCode(c) { return (c / man.hs.code_max) ** 2 * man.hs.max; }
    function getLut() {
        const sc = scaleFor(layer);
        const key = layer + '#' + sc.key;
        if (lut && lut.key === key) return lut;
        const size = 255 * LUT_SUB + 1;
        const colors = new Uint32Array(size), bands = new Uint8Array(size);
        const tpScale = (man && man.td && man.td.tp_scale) || 0.2;
        for (let i = 0; i < size; i++) {
            const code = i / LUT_SUB;
            const v = layer === 'hs' ? decodeHsCode(code) : code * tpScale;
            const b = sc.band(v);
            const c = sc.banded ? sc.bandRgb[b] : paletteAt(sc.rgbs, sc.pos(v));
            colors[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
            bands[i] = b;
        }
        lut = { key, colors, bands, scale: sc };
        return lut;
    }

    /* ================= data ================= */
    function manifestUrl() { return CFG.oceanUrl || '../data/ocean/latest.json'; }
    function fileUrl(name) { return new URL(man.base + name, new URL(manifestUrl(), location.href)).href; }
    function loadManifest() {
        if (man) return Promise.resolve(man);
        if (manPromise) return manPromise;
        manPromise = fetch(manifestUrl(), { cache: 'no-cache' })
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(m => {
                const ok = m && m.schema === 1 && m.grid && m.hs && m.td && Array.isArray(m.frames) && m.frames.length
                    && /^\d{8}T\d{6}Z\/$/.test(m.base || '');
                if (!ok) throw new Error('ocean manifest schema');
                man = m;
                frameTimes = m.frames.map(f => Date.parse(f.t));
                const now = Date.now();
                T = clamp(now, frameTimes[0], frameTimes[frameTimes.length - 1]);
                lut = null;
                return m;
            })
            .catch(e => { manPromise = null; throw e; });
        return manPromise;
    }
    /** Exact bytes of an 8-bit, non-interlaced PNG, decoded in JS. The frames
        are data, not pictures: a canvas round trip is not byte-exact on Safari
        (fingerprinting protection adds noise to getImageData, and images are
        colour-managed), which turns land (255) into speckled 20 m seas. */
    async function decodePng(blob) {
        const buf = await blob.arrayBuffer(), b = new Uint8Array(buf), dv = new DataView(buf);
        if (dv.getUint32(0) !== 0x89504e47 || dv.getUint32(4) !== 0x0d0a1a0a) throw new Error('not a PNG');
        let p = 8, w = 0, h = 0, ch = 0;
        const idat = [];
        while (p + 8 <= b.length) {
            const n = dv.getUint32(p), type = dv.getUint32(p + 4);
            if (type === 0x49484452) {           // IHDR
                w = dv.getUint32(p + 8); h = dv.getUint32(p + 12);
                ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[b[p + 17]] || 0;
                if (b[p + 16] !== 8 || !ch || b[p + 20]) throw new Error('PNG format');
            } else if (type === 0x49444154) {    // IDAT
                idat.push(b.subarray(p + 8, p + 8 + n));
            } else if (type === 0x49454e44) break;  // IEND
            p += 12 + n;
        }
        if (!ch) throw new Error('PNG header');
        const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
        const stride = w * ch, out = new Uint8Array(stride * h);
        if (raw.length < h * (stride + 1)) throw new Error('PNG data');
        for (let y = 0; y < h; y++) {
            const s = y * (stride + 1) + 1, o = y * stride, u = o - stride, ft = raw[s - 1];
            if (ft === 0) out.set(raw.subarray(s, s + stride), o);
            else if (ft === 1) for (let i = 0; i < stride; i++) out[o + i] = raw[s + i] + (i >= ch ? out[o + i - ch] : 0);
            else if (ft === 2) for (let i = 0; i < stride; i++) out[o + i] = raw[s + i] + (y ? out[u + i] : 0);
            else if (ft === 3) for (let i = 0; i < stride; i++) out[o + i] = raw[s + i] + (((i >= ch ? out[o + i - ch] : 0) + (y ? out[u + i] : 0)) >> 1);
            else if (ft === 4) for (let i = 0; i < stride; i++) {
                const a = i >= ch ? out[o + i - ch] : 0, up = y ? out[u + i] : 0, c = i >= ch && y ? out[u + i - ch] : 0;
                const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c);
                out[o + i] = raw[s + i] + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
            }
            else throw new Error('PNG filter ' + ft);
        }
        return { w, h, data: out, ch };
    }
    const canDecodePng = typeof DecompressionStream === 'function' && typeof Blob !== 'undefined' && !!Blob.prototype.stream;
    function decodeImage(url) {
        return fetch(url).then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.blob();
        }).then(async blob => {
            if (canDecodePng) {
                try { return await decodePng(blob); } catch (e) { console.warn('ocean: PNG decode fell back to canvas', e); }
            }
            let src = null;
            if (typeof createImageBitmap === 'function') {
                try { src = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) { src = null; }
            }
            if (!src) {
                src = await new Promise((resolve, reject) => {
                    const img = new Image();
                    const u = URL.createObjectURL(blob);
                    img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
                    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('decode ' + url)); };
                    img.src = u;
                });
            }
            const w = src.width, h = src.height;
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(src, 0, 0);
            const data = ctx.getImageData(0, 0, w, h).data;
            if (src.close) src.close();
            cv.width = cv.height = 0;
            // Canvas bytes can be off by a few codes: snap near-255 back to
            // nodata (codes >= 250 are > 19 m Hs / > 50 s Tp, never real).
            for (let i = 0; i < data.length; i += 4) if (data[i] >= 250) data[i] = 255;
            return { w, h, data, ch: 4 };
        });
    }
    /** Rows of the first channel → one byte per pixel. */
    function channel(img, rowStart, rows) {
        const n = img.w * rows, ch = img.ch, d = img.data, o = rowStart * img.w * ch;
        if (ch === 1) return d.slice(o, o + n);
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = d[o + i * ch];
        return out;
    }
    const frames = new Map();    // index → {p, d, used}
    let useTick = 0;
    function loadFrame(i) {
        let e = frames.get(i);
        if (e) { e.used = ++useTick; return e.p; }
        const f = man.frames[i];
        e = { used: ++useTick, d: null };
        e.p = Promise.all([decodeImage(fileUrl(f.hs)), decodeImage(fileUrl(f.td))]).then(([a, b]) => {
            const g = man.grid, td = man.td;
            if (a.w !== g.width || a.h !== g.height || b.w !== td.width || b.h !== td.height * 2) throw new Error('ocean frame size');
            e.d = { hs: channel(a, 0, a.h), tp: channel(b, 0, td.height), dir: channel(b, td.height, td.height) };
            evictFrames();
            return e.d;
        }).catch(err => { frames.delete(i); throw err; });
        frames.set(i, e);
        return e.p;
    }
    function evictFrames() {
        const done = [...frames.entries()].filter(([, e]) => e.d);
        if (done.length <= MAX_DECODED) return;
        const keep = new Set(neighbours());
        done.sort((a, b) => a[1].used - b[1].used);
        for (const [i] of done.slice(0, done.length - MAX_DECODED)) if (!keep.has(i)) frames.delete(i);
    }
    function frameData(i) { const e = frames.get(i); return e ? e.d : null; }
    /** Frames bracketing time T: {i, j, f}. */
    function bracket(t = T) {
        const n = frameTimes.length;
        if (!n) return null;
        if (t <= frameTimes[0]) return { i: 0, j: 0, f: 0 };
        if (t >= frameTimes[n - 1]) return { i: n - 1, j: n - 1, f: 0 };
        let i = 0;
        while (i < n - 2 && frameTimes[i + 1] <= t) i++;
        return { i, j: i + 1, f: (t - frameTimes[i]) / (frameTimes[i + 1] - frameTimes[i]) };
    }
    function neighbours() { const b = bracket(); return b ? [b.i, b.j] : []; }
    /** Loaded frame data for time T, falling back to the nearest loaded side. */
    function current() {
        const b = bracket();
        if (!b) return null;
        let A = frameData(b.i), B = frameData(b.j), f = b.f;
        if (!A && B) { A = B; f = 0; } else if (A && !B) { B = A; f = 0; }
        return A ? { A, B, f, b } : null;
    }
    function ensureFrames() {
        const b = bracket();
        if (!b) return Promise.resolve();
        const near = b.f < 0.5 ? [b.i, b.j] : [b.j, b.i];
        return loadFrame(near[0]).then(() => loadFrame(near[1]));
    }
    function prefetchAhead(k = 2) {
        const b = bracket();
        if (!b || navigator.connection && navigator.connection.saveData) return;
        let chain = Promise.resolve();
        for (let n = 1; n <= k; n++) {
            const i = b.j + n;
            if (i < man.frames.length && !frames.has(i)) chain = chain.then(() => loadFrame(i)).catch(() => {});
        }
    }
    function loadSummary() {
        if (summary) return Promise.resolve(summary);
        if (summaryPromise) return summaryPromise;
        const sm = man.summary;
        summaryPromise = decodeImage(fileUrl(sm.file)).then(img => {
            const planes = sm.planes || [];
            if (sm.layout !== 'planar' || img.w !== sm.width || img.h !== sm.height * planes.length) throw new Error('ocean summary layout');
            const q = [], levels = [];
            planes.forEach((name, i) => {
                const m = /^hs_p(\d+)$/.exec(name);
                if (m) { q.push(channel(img, i * sm.height, sm.height)); levels.push(Number(m[1]) / 100); }
            });
            const ci = planes.indexOf('coast_km');
            summary = { w: sm.width, h: sm.height, q, levels, coast: ci >= 0 ? channel(img, ci * sm.height, sm.height) : null };
            return summary;
        }).catch(e => { summaryPromise = null; throw e; });
        return summaryPromise;
    }
    /** Auto-contrast range: 2nd–98th percentile of Hs pooled over the run's
        frames and the sea cells in view — nearshore cells (≤ 200 km from the
        coast) when there are enough of them, so a far-offshore storm does not
        flatten the colours where the spots are. Each cell contributes its
        stored run quantiles, weighted by the share of time they stand for. */
    const NEAR_KM = 200;
    function computeAutoRange() {
        if (!summary || !map || !summary.q.length) return null;
        const sm = man.summary, g = man.grid, st = sm.stride;
        const b = map.getBounds();
        const col = lon => Math.floor((lon - g.lon_west) / g.dlon / st), row = lat => Math.floor((g.lat_north - lat) / g.dlat / st);
        const L = summary.levels, weights = L.map((p, i) => ((i + 1 < L.length ? (p + L[i + 1]) / 2 : 1) - (i ? (L[i - 1] + p) / 2 : 0)));
        const collect = (rect, nearOnly) => {
            const vals = [], wts = [];
            for (let r = clamp(rect.r0, 0, summary.h - 1); r <= clamp(rect.r1, 0, summary.h - 1); r++) {
                for (let c = clamp(rect.c0, 0, summary.w - 1); c <= clamp(rect.c1, 0, summary.w - 1); c++) {
                    const k = r * summary.w + c;
                    if (summary.q[0][k] === 255) continue;
                    if (nearOnly && summary.coast && summary.coast[k] * sm.coast_km_per_code > NEAR_KM) continue;
                    for (let i = 0; i < summary.q.length; i++) { vals.push(decodeHsCode(summary.q[i][k])); wts.push(weights[i]); }
                }
            }
            return { vals, wts, cells: vals.length / summary.q.length };
        };
        const view = { r0: row(b.getNorth()), r1: row(b.getSouth()), c0: col(b.getWest()), c1: col(b.getEast()) };
        let set = collect(view, true);
        if (set.cells < 40) set = collect(view, false);
        if (set.cells < 12) set = collect({ r0: 0, r1: summary.h - 1, c0: 0, c1: summary.w - 1 }, false);
        if (!set.cells) return null;
        const order = set.vals.map((v, i) => i).sort((x, y) => set.vals[x] - set.vals[y]);
        const total = set.wts.reduce((a, w) => a + w, 0);
        const pct = p => { let acc = 0; for (const i of order) { acc += set.wts[i]; if (acc >= p * total) return set.vals[i]; } return set.vals[order[order.length - 1]]; };
        return autoBounds(pct(0.02), pct(0.98));
    }
    function updateAutoRange() {
        if (style.scale !== 'auto' || layer !== 'hs') return;
        loadSummary().then(() => {
            const r = computeAutoRange();
            if (!r || (autoRange && autoRange.bounds.join() === r.bounds.join())) return;
            autoRange = r;
            lut = null;
            renderLegend();
            requestField('full');
        }).catch(e => console.warn('Ocean summary unavailable', e));
    }

    /* ================= sampling ================= */
    function gridXY(lat, lon) {
        const g = man.grid;
        return { fx: (lon - g.lon_west) / g.dlon, fy: (g.lat_north - lat) / g.dlat };
    }
    /** Values at a point for the current time (for the probe readout). */
    function sampleAt(lat, lon) {
        const cur = current();
        if (!cur) return null;
        const g = man.grid, { fx, fy } = gridXY(lat, lon);
        if (fx < -0.5 || fy < -0.5 || fx > g.width - 0.5 || fy > g.height - 0.5) return { land: true };
        const W = g.width, H = g.height;
        const x0 = clamp(Math.floor(fx), 0, W - 1), y0 = clamp(Math.floor(fy), 0, H - 1);
        const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), ax = clamp(fx - x0, 0, 1), ay = clamp(fy - y0, 0, 1);
        const near = cur.A.hs[clamp(Math.round(fy), 0, H - 1) * W + clamp(Math.round(fx), 0, W - 1)];
        if (near === 255) return { land: true };
        let sw = 0, sv = 0;
        [[x0, y0, (1 - ax) * (1 - ay)], [x1, y0, ax * (1 - ay)], [x0, y1, (1 - ax) * ay], [x1, y1, ax * ay]].forEach(([x, y, w]) => {
            const a = cur.A.hs[y * W + x], b = cur.B.hs[y * W + x];
            if (a === 255 || b === 255 || !w) return;
            sw += w; sv += w * (decodeHsCode(a) * (1 - cur.f) + decodeHsCode(b) * cur.f);
        });
        const td = sampleTd(cur, fx, fy);
        return { hs: sw ? sv / sw : null, tp: td ? td.tp : null, dir: td ? td.dir : null };
    }
    const DIR_SIN = new Float32Array(256), DIR_COS = new Float32Array(256);
    function dirLuts() {
        const n = (man && man.td.dir_codes) || 128;
        for (let c = 0; c < 256; c++) { const a = (c % n) * 2 * Math.PI / n; DIR_SIN[c] = Math.sin(a); DIR_COS[c] = Math.cos(a); }
    }
    /** Tp (nearest valid of the 4 td cells, time-weighted) and mean direction
        (bilinear on unit vectors) at full-res grid coordinates fx, fy. */
    function sampleTd(cur, fx, fy) {
        const td = man.td, s = td.stride, w = td.width, h = td.height;
        const tx = fx / s, ty = fy / s;
        const x0 = clamp(Math.floor(tx), 0, w - 1), y0 = clamp(Math.floor(ty), 0, h - 1);
        const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), ax = clamp(tx - x0, 0, 1), ay = clamp(ty - y0, 0, 1);
        let sx = 0, sy = 0, sw = 0, best = -1, bestW = -1, tpv = 0;
        const cells = [[x0, y0, (1 - ax) * (1 - ay)], [x1, y0, ax * (1 - ay)], [x0, y1, (1 - ax) * ay], [x1, y1, ax * ay]];
        for (const [x, y, wt] of cells) {
            const k = y * w + x;
            const ta = cur.A.tp[k], tb = cur.B.tp[k];
            if (!ta || !tb) continue;
            const da = cur.A.dir[k], db = cur.B.dir[k];
            sx += wt * (DIR_SIN[da] * (1 - cur.f) + DIR_SIN[db] * cur.f);
            sy += wt * (DIR_COS[da] * (1 - cur.f) + DIR_COS[db] * cur.f);
            sw += wt;
            if (wt > bestW) { bestW = wt; best = k; tpv = (ta * (1 - cur.f) + tb * cur.f) * td.tp_scale; }
        }
        if (!sw || best < 0) return null;
        const dir = (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
        return { tp: tpv, dir, sx: sx / sw, sy: sy / sw };
    }

    /* ================= canvas layers ================= */
    const CanvasLayer = L.Layer.extend({
        initialize(opts) { L.setOptions(this, opts); },
        onAdd(m) {
            this._map = m;
            this._canvas = L.DomUtil.create('canvas', 'oc-canvas ' + (this.options.className || ''));
            if (m._zoomAnimated) L.DomUtil.addClass(this._canvas, 'leaflet-zoom-animated');
            m.getPane(this.options.pane).appendChild(this._canvas);
            m.on('zoomanim', this._onAnimZoom, this);
            m.on('zoom', this._onZoom, this);
            this.reset();
        },
        onRemove(m) { m.off('zoomanim', this._onAnimZoom, this); m.off('zoom', this._onZoom, this); this._canvas.remove(); },
        reset() {
            const m = this._map, size = m.getSize();
            this._center = m.getCenter();
            this._zoom = m.getZoom();
            L.DomUtil.setPosition(this._canvas, m.containerPointToLayerPoint([0, 0]).round());
            this._canvas.style.width = size.x + 'px';
            this._canvas.style.height = size.y + 'px';
            return size;
        },
        _onAnimZoom(e) { this._transform(e.center, e.zoom); },
        _onZoom() { this._transform(this._map.getCenter(), this._map.getZoom()); },
        _transform(center, zoom) {
            // Same maths as L.Renderer._updateTransform (padding 0).
            const m = this._map, scale = m.getZoomScale(zoom, this._zoom);
            const offset = m.getSize().multiplyBy(0.5).multiplyBy(-scale)
                .add(m.project(this._center, zoom)).subtract(m._getNewPixelOrigin(center, zoom));
            L.DomUtil.setTransform(this._canvas, offset, scale);
        },
    });

    /* ---------- field ---------- */
    let fieldBuf = null;   // {w, h, img, u32, bands, gx, gy}
    function fieldK(quality) {
        const size = map.getSize(), area = Math.max(1, size.x * size.y), dpr = window.devicePixelRatio || 1;
        return quality === 'full' ? Math.min(dpr, Math.max(1, Math.sqrt(9e5 / area))) : Math.min(1, Math.sqrt(2.2e5 / area));
    }
    function renderField(quality) {
        if (!map || !field || !field._map || !man) return;
        const size = field.reset();
        const cv = field._canvas, ctx = cv.getContext('2d');
        const cur = current();
        if (!cur || !size.x || !size.y) { cv.width = cv.width; return; }
        const t0 = performance.now();
        const k = fieldK(quality);
        const w = Math.max(1, Math.round(size.x * k)), h = Math.max(1, Math.round(size.y * k));
        if (!fieldBuf || fieldBuf.w !== w || fieldBuf.h !== h) {
            const img = ctx.createImageData(w, h);
            fieldBuf = { w, h, img, u32: new Uint32Array(img.data.buffer), bands: new Uint8Array(w * h), gx: new Float64Array(w), gy: new Float64Array(h) };
        }
        const { img, u32, bands, gx, gy } = fieldBuf;
        const g = man.grid, W = g.width, H = g.height;
        for (let x = 0; x < w; x++) gx[x] = (map.containerPointToLatLng([(x + 0.5) / k, size.y / 2]).lng - g.lon_west) / g.dlon;
        for (let y = 0; y < h; y++) gy[y] = (g.lat_north - map.containerPointToLatLng([size.x / 2, (y + 0.5) / k]).lat) / g.dlat;
        const sharp = Math.max(1, 1 / Math.max(1e-6, Math.abs(gx[Math.min(1, w - 1)] - gx[0]) || 1));  // samples per cell
        const L_ = getLut(), colors = L_.colors, bandLut = L_.bands;
        const A = cur.A.hs, B = cur.B.hs, f = cur.f, f1 = 1 - f;
        const isTp = layer === 'tp';
        const tdw = man.td.width, tdh = man.td.height, tds = man.td.stride;
        const TA = cur.A.tp, TB = cur.B.tp;
        u32.fill(0);
        for (let y = 0; y < h; y++) {
            const fy = gy[y];
            if (fy < -0.5 || fy > H - 0.5) continue;
            const y0 = fy < 0 ? 0 : Math.min(H - 1, fy | 0), y1 = y0 + 1 < H ? y0 + 1 : y0;
            const ay = fy - y0 < 0 ? 0 : fy - y0 > 1 ? 1 : fy - y0;
            const r0 = y0 * W, r1 = y1 * W, row = y * w;
            let ty0 = 0, ty1 = 0, tay = 0;
            if (isTp) {
                const ty = fy / tds;
                ty0 = ty < 0 ? 0 : Math.min(tdh - 1, ty | 0); ty1 = ty0 + 1 < tdh ? ty0 + 1 : ty0;
                tay = ty - ty0 < 0 ? 0 : ty - ty0 > 1 ? 1 : ty - ty0;
            }
            for (let x = 0; x < w; x++) {
                const fx = gx[x];
                if (fx < -0.5 || fx > W - 0.5) continue;
                const x0 = fx < 0 ? 0 : Math.min(W - 1, fx | 0), x1 = x0 + 1 < W ? x0 + 1 : x0;
                const ax = fx - x0 < 0 ? 0 : fx - x0 > 1 ? 1 : fx - x0;
                const a00 = A[r0 + x0], a10 = A[r0 + x1], a01 = A[r1 + x0], a11 = A[r1 + x1];
                const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
                let sw = 0, sv = 0;
                if (a00 !== 255) { sw += w00; sv += w00 * (a00 * f1 + B[r0 + x0] * f); }
                if (a10 !== 255) { sw += w10; sv += w10 * (a10 * f1 + B[r0 + x1] * f); }
                if (a01 !== 255) { sw += w01; sv += w01 * (a01 * f1 + B[r1 + x0] * f); }
                if (a11 !== 255) { sw += w11; sv += w11 * (a11 * f1 + B[r1 + x1] * f); }
                if (sw < 0.2) continue;
                let code = sv / sw;
                if (isTp) {
                    const tx = fx / tds;
                    const tx0 = tx < 0 ? 0 : Math.min(tdw - 1, tx | 0), tx1 = tx0 + 1 < tdw ? tx0 + 1 : tx0;
                    const tax = tx - tx0 < 0 ? 0 : tx - tx0 > 1 ? 1 : tx - tx0;
                    let tw = 0, tv = 0, kk;
                    kk = ty0 * tdw + tx0; if (TA[kk] && TB[kk]) { const q = (1 - tax) * (1 - tay); tw += q; tv += q * (TA[kk] * f1 + TB[kk] * f); }
                    kk = ty0 * tdw + tx1; if (TA[kk] && TB[kk]) { const q = tax * (1 - tay); tw += q; tv += q * (TA[kk] * f1 + TB[kk] * f); }
                    kk = ty1 * tdw + tx0; if (TA[kk] && TB[kk]) { const q = (1 - tax) * tay; tw += q; tv += q * (TA[kk] * f1 + TB[kk] * f); }
                    kk = ty1 * tdw + tx1; if (TA[kk] && TB[kk]) { const q = tax * tay; tw += q; tv += q * (TA[kk] * f1 + TB[kk] * f); }
                    if (!tw) continue;
                    code = tv / tw;
                }
                const li = (code * LUT_SUB + 0.5) | 0;
                let col = colors[li];
                if (sw < 1) {
                    const al = (sw - 0.5) * sharp + 0.5;
                    if (al <= 0) continue;
                    if (al < 1) col = (col & 0x00ffffff) | (((al * 255) | 0) << 24);
                }
                u32[row + x] = col;
                bands[row + x] = bandLut[li];
            }
        }
        if (L_.scale.banded && quality === 'full') {
            // Isolines: darken the pixel where the band changes (right / below).
            for (let y = 0; y < h - 1; y++) {
                const row = y * w;
                for (let x = 0; x < w - 1; x++) {
                    const p = row + x, c = u32[p];
                    if (!c) continue;
                    const b = bands[p];
                    if ((u32[p + 1] && bands[p + 1] !== b) || (u32[p + w] && bands[p + w] !== b)) {
                        const r = (c & 255) * 0.62, gg = ((c >> 8) & 255) * 0.62, bb = ((c >> 16) & 255) * 0.62;
                        u32[p] = (c & 0xff000000) | ((bb | 0) << 16) | ((gg | 0) << 8) | (r | 0);
                    }
                }
            }
        }
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        ctx.putImageData(img, 0, 0);
        buildFlowGrid(size, cur);
        perf[quality] = { ms: Math.round(performance.now() - t0), px: w * h };
    }
    const perf = {};
    let fieldReq = 0, fieldQuality = 'fast';
    function requestField(quality = 'full') {
        if (quality === 'full') fieldQuality = 'full';
        if (fieldReq) return;
        fieldReq = requestAnimationFrame(() => {
            fieldReq = 0;
            const q = fieldQuality;
            fieldQuality = 'fast';
            renderField(q);
            if (reducedMotion || !flowOn) drawStatic();
            else kick();
        });
    }
    function settleSoon() {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => requestField('full'), 180);
    }

    /* ---------- flow ---------- */
    const fg = { w: 0, h: 0, vx: null, vy: null, sea: null, seaIdx: null, nSea: 0 };
    const pt = { n: 0, cap: 0, x: null, y: null, age: null, life: null, tx: null, ty: null, head: null, len: null };
    let density = 1, perfFrames = 0, perfTime = 0;
    function buildFlowGrid(size, cur) {
        const w = Math.ceil(size.x / FLOW_CELL), h = Math.ceil(size.y / FLOW_CELL), n = w * h;
        if (fg.w !== w || fg.h !== h) {
            Object.assign(fg, { w, h, vx: new Float32Array(n), vy: new Float32Array(n), sea: new Uint8Array(n), seaIdx: new Int32Array(n) });
        }
        const g = man.grid, W = g.width, Hh = g.height;
        const cols = new Float64Array(w), rows = new Float64Array(h);
        for (let x = 0; x < w; x++) cols[x] = (map.containerPointToLatLng([(x + 0.5) * FLOW_CELL, size.y / 2]).lng - g.lon_west) / g.dlon;
        for (let y = 0; y < h; y++) rows[y] = (g.lat_north - map.containerPointToLatLng([size.x / 2, (y + 0.5) * FLOW_CELL]).lat) / g.dlat;
        const speedK = Math.min(1.15, Math.max(0.8, Math.sqrt(size.x * size.y) / 700));
        let ns = 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const k = y * w + x, fx = cols[x], fy = rows[y];
                fg.sea[k] = 0; fg.vx[k] = 0; fg.vy[k] = 0;
                if (fx < 0 || fy < 0 || fx > W - 1 || fy > Hh - 1) continue;
                if (cur.A.hs[Math.round(fy) * W + Math.round(fx)] === 255) continue;
                const s = sampleTd(cur, fx, fy);
                if (!s) continue;
                const len = Math.hypot(s.sx, s.sy);
                if (len < 0.2) continue;
                const speed = (12 + 4 * s.tp) * speedK;
                // travel = from + 180°: screen x = −sin(from), screen y (down) = cos(from)
                fg.vx[k] = -s.sx / len * speed;
                fg.vy[k] = s.sy / len * speed;
                fg.sea[k] = 1;
                fg.seaIdx[ns++] = k;
            }
        }
        fg.nSea = ns;
        const want = Math.round(clamp(ns * FLOW_CELL * FLOW_CELL / 430, 0, 1600) * density);
        allocParticles(want);
    }
    function allocParticles(n) {
        if (n > pt.cap) {
            pt.cap = n;
            pt.x = new Float32Array(n); pt.y = new Float32Array(n); pt.age = new Float32Array(n); pt.life = new Float32Array(n);
            pt.tx = new Float32Array(n * TRAIL); pt.ty = new Float32Array(n * TRAIL); pt.head = new Uint8Array(n); pt.len = new Uint8Array(n);
            for (let i = 0; i < n; i++) spawn(i, true);
        } else if (n > pt.n) {
            for (let i = pt.n; i < n; i++) spawn(i, true);
        }
        pt.n = n;
    }
    function spawn(i, randomAge) {
        if (!fg.nSea) { pt.len[i] = 0; pt.x[i] = -1; return; }
        const k = fg.seaIdx[(Math.random() * fg.nSea) | 0];
        const x = (k % fg.w + Math.random()) * FLOW_CELL, y = (((k / fg.w) | 0) + Math.random()) * FLOW_CELL;
        pt.x[i] = x; pt.y[i] = y;
        pt.life[i] = 2.5 + Math.random() * 3;
        pt.age[i] = randomAge ? Math.random() * pt.life[i] : 0;
        pt.head[i] = 0; pt.len[i] = 1;
        pt.tx[i * TRAIL] = x; pt.ty[i * TRAIL] = y;
    }
    function respawnAll() { for (let i = 0; i < pt.n; i++) spawn(i, true); }
    // Trail points are stored every TRAIL_DT s, the head slot follows the
    // particle in between: a trail is ~0.5 s of travel whatever the frame rate.
    // An expiring particle (old, or reaching land / the edge) stops and its
    // tail catches up before it respawns, so nothing pops out of view.
    const TRAIL_DT = 0.05, DYING = TRAIL * TRAIL_DT;
    let trailAcc = 0;
    function stepParticles(dt) {
        const w = fg.w, h = fg.h;
        trailAcc += dt;
        const push = trailAcc >= TRAIL_DT;
        if (push) trailAcc = Math.min(TRAIL_DT, trailAcc - TRAIL_DT);
        for (let i = 0; i < pt.n; i++) {
            pt.age[i] += dt;
            let x = pt.x[i], y = pt.y[i];
            if (pt.age[i] > pt.life[i] + DYING) { spawn(i, false); continue; }
            if (pt.age[i] <= pt.life[i]) {
                const cx = (x / FLOW_CELL) | 0, cy = (y / FLOW_CELL) | 0;
                const k = cy * w + cx;
                if (x < 0 || y < 0 || cx >= w || cy >= h || !fg.sea[k]) pt.age[i] = pt.life[i] + 1e-6;
                else { x += fg.vx[k] * dt; y += fg.vy[k] * dt; pt.x[i] = x; pt.y[i] = y; }
            }
            if (push) {
                pt.head[i] = (pt.head[i] + 1) % TRAIL;
                if (pt.len[i] < TRAIL) pt.len[i]++;
            }
            const b = i * TRAIL + pt.head[i];
            pt.tx[b] = x; pt.ty[b] = y;
        }
    }
    const BUCKETS = [[0, 3, 0.9], [3, 6, 0.5], [6, TRAIL - 1, 0.2]];
    function flowCtx() {
        const cv = flow._canvas, size = flow.reset(), dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = Math.round(size.x * dpr), H = Math.round(size.y * dpr);
        if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.x, size.y);
        return ctx;
    }
    function drawParticles() {
        const ctx = flowCtx();
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.35;
        for (const [s0, s1, alpha] of BUCKETS) {
            ctx.beginPath();
            for (let i = 0; i < pt.n; i++) {
                const len = pt.len[i];
                if (len < 2) continue;
                const hd = pt.head[i], base = i * TRAIL;
                // segment s joins positions (hd - s) and (hd - s - 1)
                const last = Math.min(s1, len - 1);
                if (s0 >= last) continue;
                let p = (hd - s0 + TRAIL) % TRAIL;
                ctx.moveTo(pt.tx[base + p], pt.ty[base + p]);
                for (let s = s0 + 1; s <= last; s++) {
                    p = (hd - s + TRAIL) % TRAIL;
                    ctx.lineTo(pt.tx[base + p], pt.ty[base + p]);
                }
            }
            ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
            ctx.stroke();
        }
    }
    /** Reduced motion: short static streamlines with an arrow head. */
    function drawStatic() {
        if (!flow || !flow._map) return;
        const ctx = flowCtx();
        if (!flowOn || !fg.nSea) return;
        const gap = 34;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255,255,255,0.78)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        const size = map.getSize();
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        for (let y = gap / 2; y < size.y; y += gap) {
            for (let x = gap / 2; x < size.x; x += gap) {
                let px = x + (rnd() - 0.5) * gap * 0.6, py = y + (rnd() - 0.5) * gap * 0.6;
                const line = [[px, py]];
                for (let s = 0; s < 7; s++) {
                    const cx = (px / FLOW_CELL) | 0, cy = (py / FLOW_CELL) | 0;
                    if (cx < 0 || cy < 0 || cx >= fg.w || cy >= fg.h) break;
                    const k = cy * fg.w + cx;
                    if (!fg.sea[k]) break;
                    const v = Math.hypot(fg.vx[k], fg.vy[k]) || 1;
                    px += fg.vx[k] / v * 3.2; py += fg.vy[k] / v * 3.2;
                    line.push([px, py]);
                }
                if (line.length < 5) continue;
                ctx.moveTo(line[0][0], line[0][1]);
                for (let s = 1; s < line.length; s++) ctx.lineTo(line[s][0], line[s][1]);
                const [ex, ey] = line[line.length - 1], [bx, by] = line[line.length - 3];
                const a = Math.atan2(ey - by, ex - bx);
                ctx.moveTo(ex - 5 * Math.cos(a - 0.5), ey - 5 * Math.sin(a - 0.5));
                ctx.lineTo(ex, ey);
                ctx.lineTo(ex - 5 * Math.cos(a + 0.5), ey - 5 * Math.sin(a + 0.5));
            }
        }
        ctx.stroke();
    }

    /* ================= animation loop ================= */
    function active() { return !!map && !document.hidden && !$('direction-map-view').hidden && inView; }
    function wantsLoop() { return playing || (flowOn && !reducedMotion && !moving); }
    function kick() {
        if (!rafId && active() && wantsLoop()) { lastTs = 0; rafId = requestAnimationFrame(loop); }
    }
    function loop(ts) {
        rafId = 0;
        if (!active() || !wantsLoop()) return;
        const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 1 / 60;
        lastTs = ts;
        if (playing) advance(dt, ts);
        if (flowOn && !reducedMotion && !moving) {
            const t0 = performance.now();
            stepParticles(dt);
            drawParticles();
            adaptDensity(performance.now() - t0, dt);
        }
        rafId = requestAnimationFrame(loop);
    }
    function adaptDensity(ms, dt) {
        perfFrames++;
        perfTime += ms + Math.max(0, dt * 1000 - 17) * 0.5;
        if (perfFrames < 90) return;
        const avg = perfTime / perfFrames;
        perfFrames = 0; perfTime = 0;
        if (avg > 9 && density > 0.3) { density *= 0.75; pt.n = Math.round(pt.n * 0.75); }
        else if (avg < 3.5 && density < 1) { density = Math.min(1, density * 1.15); }
    }
    function advance(dt, ts) {
        const b = bracket();
        const tEnd = frameTimes[frameTimes.length - 1];
        const next = b.f > 0 || b.i === b.j ? b.j : b.i;
        if (!frameData(b.i) || !frameData(next)) { ensureFrames().then(() => prefetchAhead(3)).catch(() => {}); return; }
        T += dt * PLAY_HOURS_PER_S * 3600000;
        if (T >= tEnd) T = frameTimes[0];
        if (ts - lastFieldTs > 90) { lastFieldTs = ts; renderField('fast'); if (reducedMotion && flowOn) drawStatic(); prefetchAhead(3); }
        if (ts - lastUiTs > 200) { lastUiTs = ts; renderTime(); updateMarkerValues(); updateProbeTip(); }
    }
    function setPlaying(on) {
        playing = !!on && frameTimes.length > 1;
        const b = $('oc-play');
        b.setAttribute('aria-pressed', String(playing));
        b.setAttribute('aria-label', t(playing ? 'map.pause' : 'map.play'));
        b.innerHTML = playing
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
        if (playing) { ensureFrames().then(() => prefetchAhead(3)).catch(() => {}); kick(); }
        else { renderTime(); updateMarkerValues(); requestField('full'); renderReadout(); }
    }

    /* ================= spots ================= */
    function tzFor() {
        const e = S.index && S.index.byId[selected || S.current];
        return (e && e.tz) || 'UTC';
    }
    /** Point record for a spot at time T: full hourly data for the open spot,
        otherwise the coarse 3-hourly index sample. */
    function pointFor(entry) {
        let h = null;
        const tt = T == null ? Date.now() : T;
        if (entry.id === S.current && S.spotData && S.spotData.hourly.length) {
            h = S.spotData.hourly.reduce((b, x) => Math.abs(x._ms - tt) < Math.abs(b._ms - tt) ? x : b, S.spotData.hourly[0]);
        } else {
            const n = coarseCount(S.index, entry);
            if (!n) return null;
            const every = (S.index.coarse && S.index.coarse.every) || 3;
            const ci = clamp(Math.round(((tt / 1000 - S.index.t0) / S.index.step) / every), 0, n - 1);
            h = coarseHour(S.index, entry, ci);
        }
        return h;
    }
    function markerKey() {
        if (T == null || !S.index) return '';
        const every = (S.index.coarse && S.index.coarse.every) || 3;
        return [Math.round(((T / 1000 - S.index.t0) / S.index.step) / every), Math.round((T / 1000 - S.index.t0) / S.index.step), windOn, selected, S.current, !!S.spotData, getLang()].join('|');
    }
    function pillHtml(entry, h, isSel) {
        const name = isSel ? `<em>${escapeHtml(shortName(entry.name))}</em>` : '';
        if (windOn) {
            const ws = h && mapFinite(h.wind_speed_kmh), wd = h && mapFinite(h.wind_direction);
            const eff = h ? getWindEffect(h, { shore_normal: entry.sn }).key : null;
            const cls = eff === 'offshore' || eff === 'crossOff' ? 'w-off' : eff === 'onshore' || eff === 'crossOn' ? 'w-on' : 'w-cross';
            const arrow = wd != null ? `<i class="oc-arrow" style="--dir:${travelBearing(wd)}deg" aria-hidden="true"></i>` : '<i class="oc-dot" aria-hidden="true"></i>';
            return { cls: cls, html: `${arrow}${name}<b>${ws != null ? escapeHtml(fmt(ws, 0)) : '–'}</b>`, label: `${entry.name}: ${ws != null ? fmt(ws, 0) + ' km/h' : '--'}${eff ? ', ' + t('wind.' + eff) : ''}` };
        }
        const key = h ? ratingKey(h) : 'Flat';
        const v = h && mapFinite(h.ml_wave_height_max);
        return {
            cls: 'r-' + key.toLowerCase(),
            html: `<i class="oc-dot" aria-hidden="true"></i>${name}<b>${v != null ? escapeHtml(fmt(v)) : '–'}</b>`,
            label: `${entry.name}: ${v != null ? fmtRange(h.ml_wave_height_min, h.ml_wave_height_max) + ' m' : '--'}, ${ratingLabel(key)}`,
        };
    }
    function shortName(n) { const s = String(n).split(',')[0].trim(); return s.length > 16 ? s.slice(0, 15) + '…' : s; }
    function buildMarkers() {
        markerLayer.clearLayers();
        spotMarkers.clear();
        for (const entry of S.index.spots) {
            const lat = mapFinite(entry.lat), lon = mapFinite(entry.lon);
            if (lat == null || lon == null) continue;
            const m = L.marker([lat, lon], {
                icon: L.divIcon({ className: 'oc-spot', html: '<span class="oc-pill"></span>', iconSize: [44, 28], iconAnchor: [22, 14] }),
                keyboard: true, riseOnHover: true,
            }).addTo(markerLayer);
            m.on('click', () => selectSpot(entry.id));
            spotMarkers.set(entry.id, { entry, m, mode: '' });
        }
        markerStep = null;
        updateMarkerValues(true);
        layoutMarkers();
    }
    function updateMarkerValues(force) {
        if (!map || !spotMarkers.size) return;
        const key = markerKey();
        if (!force && key === markerStep) return;
        markerStep = key;
        for (const [id, o] of spotMarkers) {
            const el = o.m.getElement();
            if (!el) continue;
            const isSel = id === selected;
            const p = pillHtml(o.entry, pointFor(o.entry), isSel);
            const pill = el.firstChild;
            pill.className = `oc-pill ${p.cls}${isSel ? ' is-sel' : ''}${id === S.current && !isSel ? ' is-open' : ''}`;
            pill.innerHTML = p.html;
            el.setAttribute('aria-label', p.label);
            el.setAttribute('title', p.label);
            o.width = pill.textContent.length * 7.4 + (isSel ? 30 : 24);
        }
        layoutMarkers();
    }
    /** Greedy declutter: selected, then favourites, then the rest; a spot
        that would overlap gets a small dot, or is hidden. */
    // Map overlays (legend, zoom buttons, attribution) in container pixels:
    // pills underneath them could be neither read nor tapped.
    function overlayBoxes() {
        const c = map.getContainer().getBoundingClientRect(), out = [];
        for (const e of [$('oc-legend'), map.getContainer().querySelector('.oc-mapctl'), map.getContainer().querySelector('.leaflet-control-attribution')]) {
            if (!e || e.hidden) continue;
            const r = e.getBoundingClientRect();
            if (r.width && r.height) out.push({ x0: r.left - c.left, x1: r.right - c.left, y0: r.top - c.top, y1: r.bottom - c.top });
        }
        return out;
    }
    function layoutMarkers() {
        if (!map || !spotMarkers.size) return;
        const size = map.getSize(), placed = overlayBoxes(), dots = [];
        const favs = new Set(typeof getFavorites === 'function' ? getFavorites() : []);
        const pos = new Map(S.index.spot_order.map((id, i) => [id, i]));
        const rank = o => (o.entry.id === selected ? 1e6 : 0) + (o.entry.id === S.current ? 5e5 : 0) + (favs.has(o.entry.id) ? 1e5 : 0) - (pos.has(o.entry.id) ? pos.get(o.entry.id) : 1e4);
        const order = [...spotMarkers.values()].sort((a, b) => rank(b) - rank(a));
        const hit = (list, b) => list.some(q => b.x0 < q.x1 && b.x1 > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
        for (const o of order) {
            const p = map.latLngToContainerPoint(o.m.getLatLng());
            const el = o.m.getElement();
            if (!el) continue;
            let mode = 'hidden';
            if (p.x > -30 && p.y > -20 && p.x < size.x + 30 && p.y < size.y + 20) {
                const hw = (o.width || 44) / 2 + 2;
                const box = { x0: p.x - hw, x1: p.x + hw, y0: p.y - 13, y1: p.y + 13 };
                const dot = { x0: p.x - 5, x1: p.x + 5, y0: p.y - 5, y1: p.y + 5 };
                if (o.entry.id === selected || !hit(placed, box)) { mode = 'pill'; placed.push(box); }
                else if (!hit(placed, dot) && !hit(dots, dot)) { mode = 'dot'; dots.push(dot); }
            }
            if (mode !== o.mode) {
                o.mode = mode;
                el.classList.toggle('is-dot', mode === 'dot');
                el.classList.toggle('is-hidden', mode === 'hidden');
                el.tabIndex = mode === 'pill' ? 0 : -1;
            }
            o.m.setZIndexOffset(o.entry.id === selected ? 1000 : mode === 'pill' ? 100 : 0);
        }
    }
    function selectSpot(id) {
        selected = id;
        probe = null;
        if (probeMarker) { probeMarker.remove(); probeMarker = null; }
        updateMarkerValues(true);
        renderReadout();
        renderTime();
    }

    /* ================= UI ================= */
    function fmtTick(v) { return fmt(v, Math.abs(v - Math.round(v)) < 1e-6 ? 0 : Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 2); }
    function renderLegend() {
        const box = $('oc-legend');
        if (!box || !man) return;
        const sc = layer === 'hs' ? scaleFor('hs') : scaleFor('tp');
        const bar = $('oc-legend-bar'), ticks = $('oc-legend-ticks');
        const n = sc.bounds.length - 1;
        const P = v => (sc.pos(v) * 100).toFixed(3) + '%';
        if (sc.banded) {
            bar.style.background = '';
            bar.innerHTML = sc.bandRgb.map((c, k) => `<span style="left:${P(sc.bounds[k])};width:calc(${((sc.pos(sc.bounds[k + 1]) - sc.pos(sc.bounds[k])) * 100).toFixed(3)}% - 1px);background:rgb(${c.join(',')})"></span>`).join('');
        } else {
            const stops = [];
            for (let i = 0; i <= 24; i++) { const c = paletteAt(sc.rgbs, i / 24); stops.push(`rgb(${c.join(',')}) ${(i / 24 * 100).toFixed(1)}%`); }
            bar.innerHTML = '';
            bar.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
        }
        // Ticks sit exactly on the band boundaries the map uses.
        ticks.innerHTML = sc.bounds.slice(1, n).map(v => `<span style="left:${P(v)}">${escapeHtml(fmtTick(v))}</span>`).join('');
        requestAnimationFrame(layoutMarkers);  // the legend width may have changed
        $('oc-legend-title').textContent = t(layer === 'hs' ? 'ocean.legendHs' : 'ocean.legendTp');
        const modeEl = $('oc-legend-mode');
        if (layer === 'hs') {
            modeEl.hidden = false;
            modeEl.textContent = sc.mode === 'auto' ? t('ocean.scaleAuto', { range: `${fmtTick(sc.bounds[0])}–${fmtTick(sc.bounds[n])} m` }) : t('ocean.scaleFixed');
            box.disabled = false;
            box.setAttribute('aria-pressed', String(style.scale === 'auto'));
            box.setAttribute('aria-label', t(style.scale === 'auto' ? 'ocean.scaleAutoAria' : 'ocean.scaleFixedAria', {
                range: sc.mode === 'auto' ? `${fmtTick(sc.bounds[0])}–${fmtTick(sc.bounds[n])} m` : '',
            }));
        } else {
            modeEl.hidden = true;
            box.disabled = true;
            box.removeAttribute('aria-pressed');
            box.setAttribute('aria-label', t('ocean.legendTpAria'));
        }
        box.classList.toggle('is-auto', layer === 'hs' && sc.mode === 'auto');
    }
    function timeLabel(ms, tz) {
        return fmtInstant(ms, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    }
    function leadLabel(ms) {
        const dh = Math.round((ms - Date.now()) / 3600000);
        if (dh === 0) return t('ocean.now');
        const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto', style: 'short' });
        return Math.abs(dh) < 48 ? rtf.format(dh, 'hour') : rtf.format(Math.round(dh / 24), 'day');
    }
    function renderTime() {
        const range = $('oc-range');
        if (!man) { range.disabled = true; $('oc-time').textContent = t(manPromise ? 'ocean.loading' : 'ocean.unavailable'); $('oc-lead').textContent = ''; return; }
        const t0 = frameTimes[0], t1 = frameTimes[frameTimes.length - 1];
        const hours = Math.round((t1 - t0) / 3600000);
        range.disabled = false;
        range.max = String(hours);
        range.value = String(Math.round((T - t0) / 3600000));
        const shown = t0 + Math.round((T - t0) / 3600000) * 3600000;
        const tz = tzFor();
        $('oc-time').textContent = timeLabel(shown, tz);
        const lead = leadLabel(shown), atNow = Math.abs(Date.now() - T) < 1800000;
        $('oc-lead').textContent = lead;
        $('oc-lead').classList.toggle('is-now', atNow);
        range.setAttribute('aria-valuetext', `${timeLabel(shown, tz)}, ${lead}`);
        $('oc-now').hidden = atNow || Date.now() < t0 || Date.now() > t1;
    }
    /** Day segments, "now" mark and the selected spot's rating strip. */
    function renderTrack() {
        if (!man) return;
        const t0 = frameTimes[0], t1 = frameTimes[frameTimes.length - 1], span = t1 - t0, tz = tzFor();
        const pct = ms => ((ms - t0) / span * 100);
        const days = [];
        let start = t0, cur = zonedParts(t0, tz).date;
        for (let ms = t0 + 3600000; ms <= t1; ms += 3600000) {
            const d = zonedParts(ms, tz).date;
            if (d !== cur) { days.push([start, ms, cur]); start = ms; cur = d; }
        }
        days.push([start, t1, cur]);
        const wide = window.innerWidth > 640;
        $('oc-days').innerHTML = days.map(([a, b, d], k) => {
            const w = pct(b) - pct(a);
            const label = w > (wide ? 7 : 9) ? escapeHtml(fmtInstant(a + (b - a) / 2, tz, wide ? { weekday: 'short', day: 'numeric' } : { weekday: 'short' })) : '';
            return `<span class="oc-day${k % 2 ? ' is-alt' : ''}" style="left:${pct(a).toFixed(2)}%;width:${w.toFixed(2)}%">${label}</span>`;
        }).join('');
        const now = Date.now(), nm = $('oc-now-mark');
        nm.hidden = now < t0 || now > t1;
        nm.style.left = pct(clamp(now, t0, t1)).toFixed(2) + '%';
        const entry = S.index && S.index.byId[selected || S.current];
        const strip = $('oc-rating-strip');
        if (!entry || !entry.r) { strip.style.background = 'none'; return; }
        const COL = { G: '#1ac0c6', F: '#f59e0b', P: 'rgba(239,68,68,0.55)', '-': 'transparent' };
        const stops = [];
        for (let ms = t0; ms < t1; ms += 3 * 3600000) {
            const i = Math.round((ms / 1000 - S.index.t0) / S.index.step);
            const c = COL[entry.r[i]] || 'transparent';
            stops.push(`${c} ${pct(ms).toFixed(2)}% ${pct(Math.min(t1, ms + 3 * 3600000)).toFixed(2)}%`);
        }
        strip.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
        strip.title = t('ocean.ratingStrip', { name: entry.name });
    }
    function renderStatus() {
        const el = $('oc-status');
        el.classList.remove('critical');
        if (!man) { el.hidden = true; return; }
        const gen = Date.parse(man.generated_at);
        const age = Date.now() - gen;
        if (!Number.isFinite(gen)) { el.hidden = false; el.classList.add('critical'); el.textContent = t('ocean.ageUnknown'); return; }
        if (age <= STALE_MS) { el.hidden = true; return; }
        el.hidden = false;
        el.classList.toggle('critical', age > CRITICAL_MS);
        el.textContent = t(age > CRITICAL_MS ? 'ocean.stale' : 'ocean.delayed', { ago: fmtRelativeAge(age) });
    }
    function dirText(from) {
        return t('dir.fromTo', { from: compassLabel(from), deg: Math.round(from), to: compassLabel(travelBearing(from)) });
    }
    function arrowIcon(from) {
        return `<svg class="oc-ro-arrow" viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${travelBearing(from)}deg)"><path d="M12 3l6 8h-4v10h-4V11H6z"/></svg>`;
    }
    /** Compact value next to the probe marker: visible without scrolling on phones. */
    function updateProbeTip(v) {
        if (!probeMarker || !probe) return;
        if (v === undefined) v = man ? sampleAt(probe.lat, probe.lng) : null;
        probeMarker.setTooltipContent(!v ? '…' : v.land || v.hs == null ? escapeHtml(t('ocean.noData'))
            : `<b>${escapeHtml(fmt(v.hs))} m</b> · ${v.tp != null ? escapeHtml(fmt(v.tp, 0)) + ' s' : '--'}${v.dir != null ? ' · ' + arrowIcon(v.dir) + escapeHtml(t('dir.from', { dir: compassLabel(v.dir) })) : ''}`);
    }
    function renderReadout() {
        const el = $('oc-readout');
        if (!el || !S.index) return;
        const tz = tzFor();
        const when = T != null ? timeLabel(T0h(), tz) : '';
        if (probe) {
            const v = man ? sampleAt(probe.lat, probe.lng) : null;
            const coords = `${fmt(Math.abs(probe.lat), 2)}° ${probe.lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(probe.lng), 2)}° ${probe.lng >= 0 ? 'E' : (getLang() === 'fr' ? 'O' : 'W')}`;
            let body;
            updateProbeTip(v);
            if (!v) body = `<p class="oc-ro-note">${escapeHtml(t('ocean.loading'))}</p>`;
            else if (v.land || v.hs == null) body = `<p class="oc-ro-note">${escapeHtml(t('ocean.noSeaData'))}</p>`;
            else body = `<dl class="oc-ro-grid">
                <div><dt>${escapeHtml(t('ocean.hs'))}</dt><dd><strong>${escapeHtml(fmt(v.hs))}</strong> m</dd></div>
                <div><dt>${escapeHtml(t('ocean.tp'))}</dt><dd><strong>${v.tp != null ? escapeHtml(fmt(v.tp, 0)) : '--'}</strong> s</dd></div>
                <div class="oc-ro-wide"><dt>${escapeHtml(t('ocean.waveDir'))}</dt><dd>${v.dir != null ? arrowIcon(v.dir) + escapeHtml(dirText(v.dir)) : '--'}</dd></div>
            </dl>`;
            el.innerHTML = `<div class="oc-ro is-probe">
                <div class="oc-ro-head">
                    <span class="oc-ro-pin" aria-hidden="true"></span>
                    <div class="oc-ro-title"><strong>${escapeHtml(t('ocean.probeTitle'))}</strong><span>${escapeHtml(coords)} · ${escapeHtml(when)}</span></div>
                    <button type="button" class="oc-ro-btn" data-oc-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
                </div>${body}</div>`;
            return;
        }
        const entry = S.index.byId[selected] || S.index.byId[S.current];
        if (!entry) { el.innerHTML = ''; return; }
        const h = pointFor(entry) || {};
        const key = ratingKey(h);
        const hs = mapFinite(h.wave_height_model), tp = mapFinite(h.peak_period), wd = mapFinite(h.wave_direction);
        const ws = mapFinite(h.wind_speed_kmh), wg = mapFinite(h.wind_gusts_kmh), wn = mapFinite(h.wind_direction);
        const eff = ws != null && wn != null ? getWindEffect(h, { shore_normal: entry.sn }) : null;
        el.innerHTML = `<div class="oc-ro">
            <div class="oc-ro-head">
                <span class="oc-ro-badge r-${key.toLowerCase()}">${escapeHtml(ratingLabel(key))}</span>
                <div class="oc-ro-title"><strong>${escapeHtml(entry.name)}</strong><span>${escapeHtml([entry.region, when].filter(Boolean).join(' · '))}</span></div>
                ${entry.id !== S.current || $('direction-map-view').hidden === false ? `<button type="button" class="oc-ro-btn oc-ro-open" data-open-spot="${escapeHtml(entry.id)}">${escapeHtml(t('ocean.openForecast'))} <span aria-hidden="true">→</span></button>` : ''}
            </div>
            <dl class="oc-ro-grid">
                <div><dt>${escapeHtml(t('ocean.beach'))}</dt><dd><strong>${h.ml_wave_height_max != null ? escapeHtml(fmtRange(h.ml_wave_height_min, h.ml_wave_height_max)) : '--'}</strong> m</dd></div>
                <div><dt>${escapeHtml(t('ocean.offshore'))}</dt><dd><strong>${hs != null ? escapeHtml(fmt(hs)) : '--'}</strong> m · <strong>${tp != null ? escapeHtml(fmt(tp, 0)) : '--'}</strong> s</dd></div>
                <div><dt>${escapeHtml(t('ocean.waveDir'))}</dt><dd>${wd != null ? arrowIcon(wd) + escapeHtml(dirText(wd)) : '--'}</dd></div>
                <div><dt>${escapeHtml(t('ocean.beachWind'))}</dt><dd><strong>${ws != null ? escapeHtml(fmt(ws, 0)) : '--'}</strong> km/h${wg != null ? ' · ' + escapeHtml(t('wind.gustShort', { v: fmt(wg, 0) })) : ''}${eff && eff.key ? ` · <span style="color:${windEffectColor(eff.key)}">${escapeHtml(eff.label)}</span>` : ''}</dd></div>
            </dl></div>`;
    }
    function T0h() { const t0 = frameTimes[0] || T; return t0 + Math.round((T - t0) / 3600000) * 3600000; }

    function setLayer(which) {
        layer = which;
        document.querySelectorAll('[data-oc-layer]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.ocLayer === which)));
        lut = null;
        renderLegend();
        if (which === 'hs') updateAutoRange();
        requestField('full');
    }
    function setScale(mode) {
        style.scale = mode;
        storeSet(SCALE_KEY, mode);
        lut = null;
        if (mode === 'auto') updateAutoRange();
        renderLegend();
        requestField('full');
    }
    function setFlow(on) {
        flowOn = on;
        const b = document.querySelector('[data-oc-toggle="flow"]');
        b.setAttribute('aria-pressed', String(on));
        if (!on && flow && flow._map) flowCtx();
        if (on) { if (reducedMotion) drawStatic(); else { respawnAll(); kick(); } }
    }
    function setWind(on) {
        windOn = on;
        document.querySelector('[data-oc-toggle="wind"]').setAttribute('aria-pressed', String(on));
        updateMarkerValues(true);
    }
    function setTime(ms, { quality = 'full' } = {}) {
        if (!man) return;
        T = clamp(ms, frameTimes[0], frameTimes[frameTimes.length - 1]);
        renderTime();
        const cur = bracket();
        const ready = frameData(cur.i) && frameData(cur.j);
        if (!ready) ensureFrames().then(() => { requestField('full'); renderReadout(); }).catch(onFrameError);
        requestField(quality);
        if (quality !== 'full') settleSoon();
        updateMarkerValues();
        renderReadout();
    }
    function onFrameError(e) {
        console.warn('Ocean frame unavailable', e);
        showLoading(t(navigator.onLine ? 'ocean.fieldUnavailable' : 'ocean.fieldOffline'));
    }
    function showLoading(text) {
        const el = $('oc-loading');
        el.hidden = !text;
        el.textContent = text || '';
    }
    function spotView(entry) {
        if (!entry || entry.lat == null) return null;
        const mobile = window.innerWidth <= 600;
        const zoom = mobile ? 5.5 : 6;
        if (entry.sn == null) return { center: [entry.lat, entry.lon], zoom };
        // Centre offshore, between the way the beach faces and where the swell
        // comes from now, so the spot sits near the edge of the view with the
        // incoming swell in front of it.
        let sx = Math.sin(entry.sn * Math.PI / 180), sy = Math.cos(entry.sn * Math.PI / 180);
        const h = S.index && coarseCount(S.index, entry) ? pointFor(entry) : null;
        const wd = h && mapFinite(h.wave_direction);
        if (wd != null && Math.cos((wd - entry.sn) * Math.PI / 180) > 0) { sx += Math.sin(wd * Math.PI / 180); sy += Math.cos(wd * Math.PI / 180); }
        const a = Math.atan2(sx, sy), dist = mobile ? 3 : 3.6;
        return { center: [entry.lat + Math.cos(a) * dist * 0.75, entry.lon + Math.sin(a) * dist / Math.max(0.45, Math.cos(entry.lat * Math.PI / 180))], zoom };
    }
    function recenter() {
        const v = spotView(S.index.byId[selected || S.current]);
        if (v) map.setView(v.center, v.zoom);
    }

    /* ================= map ================= */
    function buildMap() {
        const el = $('direction-map');
        const TL = Maps.TILES;
        map = L.map(el, {
            zoomControl: false, scrollWheelZoom: false, zoomSnap: 0.25, zoomDelta: 0.5,
            minZoom: 3.5, maxZoom: 10, maxBounds: [[18, -40], [64, 20]], maxBoundsViscosity: 0.7,
            attributionControl: true,
        });
        map.attributionControl.setPrefix(false);
        [['ocFieldPane', 250], ['ocFlowPane', 330], ['ocLabelsPane', 380]].forEach(([n, z]) => {
            map.createPane(n);
            map.getPane(n).style.zIndex = z;
            map.getPane(n).style.pointerEvents = 'none';
        });
        L.tileLayer(TL.dark, { maxZoom: 12, minZoom: 3, attribution: `<a href="https://doi.org/10.48670/moi-00025" target="_blank" rel="noopener">Copernicus Marine IBI</a> · ${TL.attr} · <a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>` }).addTo(map);
        field = new CanvasLayer({ pane: 'ocFieldPane', className: 'oc-field' }).addTo(map);
        flow = new CanvasLayer({ pane: 'ocFlowPane', className: 'oc-flow' }).addTo(map);
        L.tileLayer(TL.darkLabels, { pane: 'ocLabelsPane', maxZoom: 12, minZoom: 3, className: 'oc-labels' }).addTo(map);
        markerLayer = L.layerGroup().addTo(map);

        const Ctl = L.Control.extend({
            options: { position: 'topright' },
            onAdd() {
                const box = L.DomUtil.create('div', 'oc-mapctl');
                box.innerHTML = `<button type="button" data-z="1" aria-label="${escapeHtml(t('ocean.zoomIn'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>`
                    + `<button type="button" data-z="-1" aria-label="${escapeHtml(t('ocean.zoomOut'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg></button>`
                    + `<button type="button" data-z="0" aria-label="${escapeHtml(t('ocean.recenter'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/></svg></button>`;
                L.DomEvent.disableClickPropagation(box);
                box.addEventListener('click', e => {
                    const b = e.target.closest('button');
                    if (!b) return;
                    const z = Number(b.dataset.z);
                    if (z) map.setZoom(map.getZoom() + z * 1); else recenter();
                });
                return box;
            },
        });
        map.addControl(new Ctl());
        const attrib = el.querySelector('.leaflet-control-attribution');
        if (attrib) attrib.addEventListener('click', e => { if (!e.target.closest('a')) attrib.classList.toggle('is-open'); });

        map.on('movestart zoomstart', () => { moving = true; if (flow && flow._map) flowCtx(); });
        let lastMoveRender = 0;
        map.on('move', () => {
            if (!moving || !field._map || map.getZoom() !== field._zoom) return;
            const now = performance.now();
            if (now - lastMoveRender < 70) return;
            lastMoveRender = now;
            requestField('fast');
        });
        map.on('moveend', () => {
            moving = false;
            layoutMarkers();
            requestField('full');
            respawnSoon();
            updateAutoRangeSoon();
        });
        map.on('click', e => {
            probe = e.latlng;
            if (!probeMarker) {
                probeMarker = L.marker(probe, { icon: L.divIcon({ className: 'oc-probe', html: '<span></span>', iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false, keyboard: false }).addTo(map);
                probeMarker.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -14], className: 'oc-probe-tip', opacity: 1 });
            } else probeMarker.setLatLng(probe);
            renderReadout();
        });
        // ?ocView=lat,lon,zoom (debug / screenshots)
        const qv = (new URLSearchParams(location.search).get('ocView') || '').split(',').map(Number);
        const v = spotView(currentEntry());
        if (qv.length === 3 && qv.every(Number.isFinite)) map.setView([qv[0], qv[1]], qv[2], { animate: false });
        else if (v) map.setView(v.center, v.zoom, { animate: false });
        else map.fitBounds(IBI_VIEW, { animate: false });
    }
    let respawnTimer = 0, autoTimer = 0;
    function respawnSoon() { clearTimeout(respawnTimer); respawnTimer = setTimeout(() => { respawnAll(); kick(); }, 60); }
    function updateAutoRangeSoon() { clearTimeout(autoTimer); autoTimer = setTimeout(updateAutoRange, 350); }

    function wireUi() {
        document.querySelectorAll('[data-oc-layer]').forEach(b => b.addEventListener('click', () => setLayer(b.dataset.ocLayer)));
        const seg = document.querySelector('.oc-seg');
        seg.addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
            e.preventDefault();
            const next = layer === 'hs' ? 'tp' : 'hs';
            setLayer(next);
            seg.querySelector(`[data-oc-layer="${next}"]`).focus();
        });
        document.querySelector('[data-oc-toggle="flow"]').addEventListener('click', () => setFlow(!flowOn));
        document.querySelector('[data-oc-toggle="wind"]').addEventListener('click', () => setWind(!windOn));
        $('oc-legend').addEventListener('click', () => { if (layer === 'hs') setScale(style.scale === 'auto' ? 'fixed' : 'auto'); });
        $('oc-play').addEventListener('click', () => setPlaying(!playing));
        $('oc-now').addEventListener('click', () => { setPlaying(false); setTime(Date.now()); });
        $('oc-range').addEventListener('input', e => {
            if (playing) setPlaying(false);
            setTime(frameTimes[0] + Number(e.target.value) * 3600000, { quality: 'fast' });
        });
        $('oc-readout').addEventListener('click', e => {
            if (e.target.closest('[data-oc-close]')) {
                probe = null;
                if (probeMarker) { probeMarker.remove(); probeMarker = null; }
                renderReadout();
                return;
            }
            const b = e.target.closest('[data-open-spot]');
            if (!b) return;
            const id = b.dataset.openSpot, focus = S.index.byId[id] ? new Date(T0h()).toISOString().replace('.000Z', 'Z') : null;
            switchView('forecast');
            openSpot(id, { focusTime: focus });
            window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
        });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { if (playing) setPlaying(false); } else kick(); });
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion = mq.matches;
        const onMq = () => { reducedMotion = mq.matches; if (reducedMotion) drawStatic(); else { respawnAll(); kick(); } };
        if (mq.addEventListener) mq.addEventListener('change', onMq);
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(es => { inView = es.some(e => e.isIntersecting); if (inView) kick(); }, { threshold: 0.05 }).observe($('direction-map'));
        }
        window.addEventListener('resize', () => { if (map && active()) { map.invalidateSize(); renderTrack(); } });
        setInterval(() => { if (active() && man) { renderTime(); renderTrack(); renderStatus(); } }, 60000);
    }

    /** Bring the map + timeline into view: the view tabs go just under the
        sticky header (only when the timeline would otherwise be cut off). */
    function scrollIntoPlace() {
        const tabs = document.querySelector('.primary-view-tabs');
        const header = document.querySelector('.header');
        const tl = document.querySelector('.oc-timeline');
        if (!tabs || !tl || tl.getBoundingClientRect().bottom <= window.innerHeight) return;
        const top = tabs.getBoundingClientRect().top - (header ? header.getBoundingClientRect().height : 0) - 6;
        if (top > 40) window.scrollTo({ top: window.scrollY + top, behavior: reducedMotion ? 'auto' : 'smooth' });
    }

    /* ================= public ================= */
    function show() {
        if (!S.index) return;
        if (!map) {
            selected = S.current;
            wireUi();
            buildMap();
            buildMarkers();
            setFlow(true);
            renderReadout();
            showLoading(t('ocean.loadingField'));
            loadManifest().then(() => {
                dirLuts();
                renderStatus();
                renderLegend();
                renderTime();
                renderTrack();
                if (style.scale === 'auto') updateAutoRange();
                // First paint needs one frame pair (~135 KB): the nearest one.
                // The other side of the bracket follows for the time blend.
                const b = bracket();
                return loadFrame(b.f < 0.5 ? b.i : b.j);
            }).then(() => {
                showLoading('');
                $('direction-map').setAttribute('aria-busy', 'false');
                requestField('full');
                updateMarkerValues(true);
                renderReadout();
                ensureFrames().then(() => requestField('full')).catch(onFrameError);
                setTimeout(() => prefetchAhead(2), 2500);
            }).catch(e => {
                console.warn('Ocean data unavailable', e);
                $('direction-map').setAttribute('aria-busy', 'false');
                showLoading(t(navigator.onLine ? 'ocean.fieldUnavailable' : 'ocean.fieldOffline'));
                renderTime();
            });
        }
        scrollIntoPlace();
        setTimeout(() => {
            map.invalidateSize();
            layoutMarkers();
            requestField('full');
            renderTrack();
            kick();
        }, 0);
    }
    function onSpotChanged() {
        if (!map) return;
        selected = S.current;
        probe = null;
        if (probeMarker) { probeMarker.remove(); probeMarker = null; }
        updateMarkerValues(true);
        renderReadout();
        renderTime();
        renderTrack();
        if (!$('direction-map-view').hidden) {
            const e = currentEntry();
            if (e && e.lat != null) map.panInside([e.lat, e.lon], { padding: [60, 60], animate: false });
        }
    }
    function onIndexChanged() { if (map) { buildMarkers(); renderReadout(); renderTrack(); } }
    function relabel() {
        if (!map) return;
        if (playing) setPlaying(false);
        renderLegend();
        renderTime();
        renderTrack();
        renderStatus();
        updateMarkerValues(true);
        renderReadout();
        const ctl = document.querySelectorAll('.oc-mapctl button');
        ['ocean.zoomIn', 'ocean.zoomOut', 'ocean.recenter'].forEach((k, i) => ctl[i] && ctl[i].setAttribute('aria-label', t(k)));
    }
    function stop() { if (playing) setPlaying(false); }
    return { show, onSpotChanged, onIndexChanged, relabel, stop, _debug: () => ({ man, T, layer, style, autoRange, particles: pt.n, density, perf, looping: !!rafId, playing, frames: [...frames.keys()] }) };
})();
window.Ocean = Ocean;
