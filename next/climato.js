/* PeakSurf /next/ — 32-year climatology (loaded when the section is opened).
   Data: climato_summary.json {spot_id: {year_start, year_end, n_years,
   shore_normal, annual{…}, monthly[12]{…}, swell_rose[8][3], wind_rose[8][3],
   yearly_session[]}}. Charts are drawn at their on-screen pixel width so
   SVG text stays at >= 12 px. */
'use strict';

const Climato = (() => {
    const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let data = null, loading = null, renderedFor = null;

    function monthLabel(m, style) {
        const i = MONTHS_EN.indexOf(m);
        if (i < 0) return m || '–';
        return fmtDate(`2021-${pad2(i + 1)}-15`, { month: style });
    }
    function tier(p) { return p == null ? 'climato-tier-poor' : p >= 50 ? 'climato-tier-good' : p >= 35 ? 'climato-tier-fair' : 'climato-tier-poor'; }
    function width(id, fallback) {
        const el = document.getElementById(id);
        const w = el && el.parentElement ? el.parentElement.clientWidth - 2 : 0;
        return Math.max(280, Math.round(w || fallback));
    }
    function setSvg(id, w, h, content, label) {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('viewBox', `0 0 ${w} ${h}`);
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', label);
        el.innerHTML = content;
    }
    function monthTicks(months, xAt, y, step) {
        const style = step >= 34 ? 'short' : 'narrow';
        return months.map((m, i) => `<text x="${xAt(i)}" y="${y}" text-anchor="middle">${escapeHtml(monthLabel(m.month, style))}</text>`).join('');
    }

    function monthlySession(c) {
        const id = 'climato-monthly-session';
        const W = width(id, 480), H = 190, pl = 40, pr = 8, pt = 18, pb = 26;
        const iw = W - pl - pr, ih = H - pt - pb;
        const months = c.monthly;
        const maxPct = Math.max(60, ...months.map(m => m.session_pct || 0));
        const step = iw / 12, bw = step * 0.72;
        let s = '';
        for (let p = 0; p <= maxPct; p += 20) {
            const y = pt + ih - (p / maxPct) * ih;
            s += `<line class="climato-axis" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${y + 4}" text-anchor="end">${p}%</text>`;
        }
        months.forEach((m, i) => {
            const p = m.session_pct || 0;
            const x = pl + step * i + (step - bw) / 2, h = (p / maxPct) * ih, y = pt + ih - h;
            s += `<rect class="${tier(p)}" x="${x}" y="${y}" width="${bw}" height="${h}" rx="2"><title>${escapeHtml(monthLabel(m.month, 'long'))} : ${fmt(p, 1)} %</title></rect>`;
            if (p >= 5 && step >= 22) s += `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" style="fill:var(--text-dark);font-weight:700">${Math.round(p)}</text>`;
        });
        s += monthTicks(months, i => pl + step * i + step / 2, pt + ih + 18, step);
        setSvg(id, W, H, s, t('climato.sessionTitle'));
    }
    function monthlyHs(c) {
        const id = 'climato-monthly-hs';
        const W = width(id, 480), H = 190, pl = 40, pr = 12, pt = 14, pb = 26;
        const iw = W - pl - pr, ih = H - pt - pb;
        const months = c.monthly;
        const maxHs = Math.max(3, ...months.map(m => m.hs_p75 || 0)) * 1.05;
        const step = iw / 11, xAt = i => pl + step * i, yAt = v => pt + ih - (v / maxHs) * ih;
        let s = '';
        for (let v = 0; v <= maxHs; v += 0.5) {
            const y = yAt(v);
            if (v > 0) s += `<line class="climato-axis" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/>`;
            if (v % 1 === 0 || maxHs < 3.5) s += `<text x="${pl - 4}" y="${y + 4}" text-anchor="end">${fmt(v, 1)}</text>`;
        }
        const top = months.map((m, i) => `${xAt(i)},${yAt(m.hs_p75 || 0)}`);
        const bot = months.map((m, i) => `${xAt(i)},${yAt(m.hs_p25 || 0)}`).reverse();
        s += `<polygon class="climato-band" points="${top.concat(bot).join(' ')}"/>`;
        s += `<path class="climato-line" d="${months.map((m, i) => `${i ? 'L' : 'M'}${xAt(i)},${yAt(m.hs_med || 0)}`).join(' ')}"/>`;
        months.forEach((m, i) => {
            s += `<circle cx="${xAt(i)}" cy="${yAt(m.hs_med || 0)}" r="3" fill="var(--accent)"><title>${escapeHtml(t('climato.hsPoint', { m: monthLabel(m.month, 'long'), med: fmt(m.hs_med, 2), p25: fmt(m.hs_p25, 2), p75: fmt(m.hs_p75, 2) }))}</title></circle>`;
        });
        s += monthTicks(months, xAt, pt + ih + 18, step);
        setSvg(id, W, H, s, t('climato.hsTitle'));
    }
    function monthlyMl(c) {
        const id = 'climato-monthly-ml-waves';
        const months = c.monthly || [];
        const card = document.getElementById(id).closest('.climato-card');
        if (!months.some(m => m && m.ml_wave_sets_med != null)) { card.hidden = true; return; }
        card.hidden = false;
        const W = width(id, 480), H = 230, pl = 40, pr = 12, pt = 44, pb = 26;
        const iw = W - pl - pr, ih = H - pt - pb;
        const maxY = Math.max(1.5, ...months.map(m => m.ml_wave_sets_p75 || m.ml_wave_sets_med || 0)) * 1.1;
        const step = iw / 11, xAt = i => pl + step * i, yAt = v => pt + ih - (v / maxY) * ih;
        let s = '';
        for (let v = 0; v <= maxY + 1e-6; v += 0.5) {
            const y = yAt(v);
            if (v > 0) s += `<line class="climato-axis" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/>`;
            s += `<text x="${pl - 4}" y="${y + 4}" text-anchor="end">${fmt(v, 1)}</text>`;
        }
        if (months.every(m => m.ml_wave_sets_p75 != null && m.ml_wave_sets_med != null)) {
            const top = months.map((m, i) => `${xAt(i)},${yAt(m.ml_wave_sets_p75)}`);
            const bot = months.map((m, i) => `${xAt(i)},${yAt(m.ml_wave_sets_med)}`).reverse();
            s += `<polygon class="climato-band-orange" points="${top.concat(bot).join(' ')}"/>`;
        }
        const lines = [
            { key: 'ml_wave_min_med', color: '#3b82f6', label: t('climato.lineMin') },
            { key: 'ml_wave_max_med', color: '#1ac0c6', label: t('climato.lineAvg') },
            { key: 'ml_wave_sets_med', color: '#f59e0b', label: t('climato.lineSets') },
        ];
        lines.forEach(L => {
            const pts = months.map((m, i) => m[L.key] != null ? `${xAt(i)},${yAt(m[L.key])}` : null).filter(Boolean);
            if (pts.length) s += `<path d="M${pts.join(' L')}" fill="none" stroke="${L.color}" stroke-width="2"/>`;
            months.forEach((m, i) => { if (m[L.key] != null) s += `<circle cx="${xAt(i)}" cy="${yAt(m[L.key])}" r="2.8" fill="${L.color}"><title>${escapeHtml(`${monthLabel(m.month, 'long')} : ${L.label} ${fmt(m[L.key], 2)} m`)}</title></circle>`; });
        });
        s += monthTicks(months, xAt, pt + ih + 18, step);
        // legend on top, wrapped to the width
        let lx = pl, ly = 14;
        lines.forEach(L => {
            const w = 22 + L.label.length * 7;
            if (lx + w > W - pr) { lx = pl; ly += 16; }
            s += `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 14}" y2="${ly - 4}" stroke="${L.color}" stroke-width="2.5"/><text x="${lx + 18}" y="${ly}">${escapeHtml(L.label)}</text>`;
            lx += w + 8;
        });
        setSvg(id, W, H, s, t('climato.mlTitle'));
    }
    function roseSectors(rose, rIn, rOut, cls, valLabels, unit) {
        if (!rose || rose.length !== 8) return '';
        const maxTotal = Math.max(0.001, ...rose.map(b => b.reduce((a, x) => a + x, 0)));
        let s = '';
        rose.forEach((bands, i) => {
            const a0 = i * 45 - 90 - 22.5;
            let cum = 0;
            bands.forEach((freq, b) => {
                if (freq <= 0) { cum += freq; return; }
                const r0 = rIn + (cum / maxTotal) * (rOut - rIn), r1 = rIn + ((cum + freq) / maxTotal) * (rOut - rIn);
                cum += freq;
                const A = a0 * Math.PI / 180, B = (a0 + 45) * Math.PI / 180;
                const d = `M${Math.cos(A) * r1},${Math.sin(A) * r1} A${r1},${r1} 0,0,1 ${Math.cos(B) * r1},${Math.sin(B) * r1} L${Math.cos(B) * r0},${Math.sin(B) * r0} A${r0},${r0} 0,0,0 ${Math.cos(A) * r0},${Math.sin(A) * r0} Z`;
                s += `<path d="${d}" class="rose-${cls}-${b}"><title>${escapeHtml(`${compassLabel(i * 45)} ${valLabels[b]} ${unit} : ${fmt(freq * 100, 1)} %`)}</title></path>`;
            });
        });
        return s;
    }
    function compass(c) {
        const el = document.getElementById('climato-compass');
        const card = el.closest('.climato-card');
        if (!c.swell_rose || !c.wind_rose) { card.hidden = true; return; }
        card.hidden = false;
        const swellColors = ['#1e2e45', '#1ac0c6', '#ef4444'], windColors = ['#1e2e45', '#f59e0b', '#ef4444'];
        const swellLabels = ['<0,5', '0,5–1,5', '≥1,5'].map(x => getLang() === 'fr' ? x : x.replace(/,/g, '.'));
        const windLabels = ['<10', '10–20', '≥20'];
        const RO = 110, RM = 78, RI = 28;
        // The rose uses a fixed 320-unit viewBox; when it renders narrower
        // than 320 px, enlarge the text so it never drops below 12 px on screen.
        const avail = el.parentElement ? el.parentElement.clientWidth - 2 : 320;
        const fs = avail > 0 && avail < 320 ? Math.ceil(12 * 320 / avail) : 12;
        let s = `<style>
            #climato-compass text{font-size:${fs}px}
            .rose-swell-0{fill:${swellColors[0]}}.rose-swell-1{fill:${swellColors[1]}}.rose-swell-2{fill:${swellColors[2]}}
            .rose-wind-0{fill:${windColors[0]}}.rose-wind-1{fill:${windColors[1]}}.rose-wind-2{fill:${windColors[2]}}
            [class^="rose-"]{stroke:var(--bg-surface);stroke-width:0.5}</style>`;
        [RI, RM, RO].forEach(r => { s += `<circle cx="0" cy="0" r="${r}" fill="none" stroke="var(--border)" stroke-width="0.5"/>`; });
        for (let i = 0; i < 8; i++) {
            const a = (i * 45 - 90 - 22.5) * Math.PI / 180;
            s += `<line class="climato-rose-spoke" x1="${Math.cos(a) * RI}" y1="${Math.sin(a) * RI}" x2="${Math.cos(a) * RO}" y2="${Math.sin(a) * RO}"/>`;
        }
        s += roseSectors(c.swell_rose, RI, RM, 'swell', swellLabels, 'm');
        s += roseSectors(c.wind_rose, RM, RO, 'wind', windLabels, 'km/h');
        for (let i = 0; i < 8; i++) {
            const a = (i * 45 - 90) * Math.PI / 180;
            s += `<text class="climato-rose-label" x="${Math.cos(a) * (RO + 16)}" y="${Math.sin(a) * (RO + 16) + 4}" text-anchor="middle">${compassLabel(i * 45)}</text>`;
        }
        const sn = c.shore_normal != null ? c.shore_normal : 270;
        const ar = (sn - 90) * Math.PI / 180;
        const tipX = Math.cos(ar) * (RI - 4), tipY = Math.sin(ar) * (RI - 4);
        const bX = -Math.cos(ar) * (RI - 12), bY = -Math.sin(ar) * (RI - 12);
        const h1 = [Math.cos(ar + Math.PI - 0.5), Math.sin(ar + Math.PI - 0.5)], h2 = [Math.cos(ar + Math.PI + 0.5), Math.sin(ar + Math.PI + 0.5)];
        s += `<line x1="${bX}" y1="${bY}" x2="${tipX}" y2="${tipY}" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`;
        s += `<polygon points="${tipX},${tipY} ${tipX + h1[0] * 7},${tipY + h1[1] * 7} ${tipX + h2[0] * 7},${tipY + h2[1] * 7}" fill="#fff"/>`;
        const legend = (y, title, colors, labels, unit) => {
            let o = `<text x="-155" y="${y + 1}" style="font-weight:700;fill:var(--text-dark)">${escapeHtml(title)}</text>`;
            labels.forEach((l, b) => {
                const x = -100 + b * 86;   // unit only after the last label, so text fits at 14–15 px
                o += `<rect x="${x}" y="${y - 9}" width="11" height="11" fill="${colors[b]}" rx="2"/><text x="${x + 15}" y="${y + 1}">${escapeHtml(b === labels.length - 1 ? `${l} ${unit}` : l)}</text>`;
            });
            return o;
        };
        const ly = RO + 34;
        s += legend(ly, t('climato.swell'), swellColors, swellLabels, 'm');
        s += legend(ly + 20, t('climato.wind'), windColors, windLabels, 'km/h');
        s += `<text x="0" y="${ly + 44}" text-anchor="middle">${escapeHtml(t('climato.arrowCaption', { deg: sn }))}</text>`;
        el.setAttribute('viewBox', `-160 -140 320 ${140 + ly + 52}`);
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', t('climato.roseTitle'));
        el.innerHTML = s;
    }
    function yearly(c) {
        const id = 'climato-yearly';
        const yrs = c.yearly_session || [];
        const card = document.getElementById(id).closest('.climato-card');
        const valid = yrs.map((v, i) => v == null ? null : [i, v]).filter(Boolean);
        if (!valid.length) { card.hidden = true; return; }
        card.hidden = false;
        const W = width(id, 720), H = 150, pl = 42, pr = 14, pt = 14, pb = 26;
        const iw = W - pl - pr, ih = H - pt - pb;
        const maxP = Math.max(60, ...valid.map(p => p[1])), minP = Math.min(20, ...valid.map(p => p[1]));
        const xAt = i => pl + (i / Math.max(1, yrs.length - 1)) * iw, yAt = v => pt + ih - ((v - minP) / (maxP - minP)) * ih;
        let s = '';
        [minP, (minP + maxP) / 2, maxP].forEach(v => { const y = yAt(v); s += `<line class="climato-axis" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${y + 4}" text-anchor="end">${Math.round(v)}%</text>`; });
        s += `<path class="climato-line" d="${valid.map(([i, v], k) => `${k ? 'L' : 'M'}${xAt(i)},${yAt(v)}`).join(' ')}"/>`;
        valid.forEach(([i, v]) => { s += `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="2.2" fill="var(--accent)"><title>${c.year_start + i} : ${fmt(v, 1)} %</title></circle>`; });
        if (valid.length > 5) {
            const n = valid.length;
            const sx = valid.reduce((a, p) => a + p[0], 0), sy = valid.reduce((a, p) => a + p[1], 0);
            const sxy = valid.reduce((a, p) => a + p[0] * p[1], 0), sx2 = valid.reduce((a, p) => a + p[0] * p[0], 0);
            const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx), icpt = (sy - slope * sx) / n;
            const i0 = valid[0][0], i1 = valid[n - 1][0];
            s += `<line x1="${xAt(i0)}" y1="${yAt(icpt + slope * i0)}" x2="${xAt(i1)}" y2="${yAt(icpt + slope * i1)}" stroke="var(--text-light)" stroke-width="1" stroke-dasharray="3,3"/>`;
        }
        const every = iw / yrs.length < 9 ? 10 : 5;
        yrs.forEach((v, i) => {
            const yr = c.year_start + i;
            if (yr % every === 0 || i === yrs.length - 1) s += `<text x="${xAt(i)}" y="${pt + ih + 18}" text-anchor="middle">${yr}</text>`;
        });
        setSvg(id, W, H, s, t('climato.yearlyTitle', { a: c.year_start, b: c.year_end }));
    }
    function annual(c) {
        const a = c.annual || {};
        const clr = p => p == null ? 'var(--text-muted)' : p >= 50 ? 'var(--good)' : p >= 35 ? 'var(--fair)' : 'var(--poor)';
        const cell = (label, val, sub, color) => `<div class="ca-cell"><span class="ca-label">${escapeHtml(label)}</span><span class="ca-val"${color ? ` style="color:${color}"` : ''}>${val}</span><span class="ca-sub">${escapeHtml(sub)}</span></div>`;
        const unit = u => `<span class="ca-unit">${u}</span>`;
        document.getElementById('climato-annual').innerHTML = [
            cell(t('climato.sessionsYear'), `${fmt(a.session_pct, 1)}${unit('%')}`, t('climato.ofHours'), clr(a.session_pct)),
            cell(t('climato.bestMonth'), escapeHtml(monthLabel(a.best_month, 'long')), a.best_pct != null ? t('climato.pctSessions', { v: fmt(a.best_pct, 1) }) : ''),
            cell(t('climato.worstMonth'), escapeHtml(monthLabel(a.worst_month, 'long')), a.worst_pct != null ? t('climato.pctSessions', { v: fmt(a.worst_pct, 1) }) : ''),
            cell(t('climato.waveHeight'), `${fmt(a.hs_med, 2)}${unit('m')}`, `P75 ${fmt(a.hs_p75, 2)} · P90 ${fmt(a.hs_p90, 2)} m`),
            cell(t('climato.period'), `${fmt(a.tp_med, 1)}${unit('s')}`, t('climato.medianTp')),
            cell(t('climato.wind'), `${fmt(a.wind_med, 1)}${unit('km/h')}`, t('climato.medianSpeed')),
        ].join('');
    }

    function render() {
        const status = document.getElementById('climato-status');
        const body = document.getElementById('climato-wrap');
        const period = document.getElementById('climato-period');
        if (!data) return;
        const c = data[S.current];
        if (!c || !Array.isArray(c.monthly) || c.monthly.length !== 12) {
            body.hidden = true;
            period.textContent = '';
            status.textContent = t('climato.noData');
            renderedFor = S.current;
            return;
        }
        status.textContent = '';
        body.hidden = false;
        period.textContent = t('climato.periodLine', { a: c.year_start, b: c.year_end, n: c.n_years });
        try {
            annual(c); monthlySession(c); monthlyHs(c); monthlyMl(c); compass(c); yearly(c);
        } catch (e) {
            console.error('climato render error', e);
            status.textContent = t('climato.renderError');
        }
        renderedFor = S.current;
    }
    function open() {
        if (data) { if (renderedFor !== S.current) render(); return Promise.resolve(); }
        if (loading) return loading;
        const status = document.getElementById('climato-status');
        status.textContent = t('climato.loading');
        loading = fetchJson(CFG.climatoUrl, { retries: 1 })
            .then(r => { data = r.data; loading = null; render(); })
            .catch(e => {
                loading = null;
                status.innerHTML = `${escapeHtml(t('climato.loadFailed'))} <button type="button" class="btn">${escapeHtml(t('common.retry'))}</button>`;
                status.querySelector('button').onclick = open;
                console.error('climato fetch error', e);
            });
        return loading;
    }
    function isOpen() { const d = document.getElementById('climato-details'); return d && d.open; }
    function onSpotChanged() { renderedFor = null; if (isOpen()) open(); }
    function relabel() { renderedFor = null; if (isOpen() && data) render(); }
    let rz;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (isOpen() && data) render(); }, 250); });
    return { open, onSpotChanged, relabel };
})();
window.Climato = Climato;
