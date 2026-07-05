/* PeakSurf /next/ — maps (loaded on demand with vendored Leaflet).
   1. Spots map: every spot coloured by rating / waves / wind…, driven by the
      coarse 3-hourly series in index.json (no per-spot downloads).
   2. Ocean map: delegated to ocean.js (Copernicus Marine IBI swell field,
      lazy per-frame PNGs under data/ocean/), loaded when the tab is opened. */
'use strict';

const Maps = (() => {
    const RATING_COLORS = { Epic: '#1ac0c6', Good: '#1ac0c6', Fair: '#f59e0b', Poor: '#ef4444', Flat: '#1e2e45' };
    const SURFACE_COLORS = { Clean: '#1ac0c6', Textured: '#f59e0b', Messy: '#ef4444' };
    const WAVE_SCALE = [[0, '#1e2e45'], [0.15, '#0ea5e9'], [0.4, '#10b981'], [0.65, '#f59e0b'], [1, '#ef4444']];
    const WIND_SCALE = [[0, '#10b981'], [0.3, '#f59e0b'], [0.6, '#ef4444'], [1, '#dc2626']];
    const PERIOD_SCALE = [[0, '#ef4444'], [0.3, '#f59e0b'], [0.6, '#10b981'], [1, '#1ac0c6']];
    // Esri Canvas tiles: keyless. CARTO basemaps began returning an
    // "API KEY REQUIRED" tile in 2026-09.
    const TILE_ATTR = 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
    const TILE_DARK = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
    const TILE_DARK_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
    
    function lerpColor(a, b, f) {
        const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
        const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
        const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * f));
        return '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    }
    function colorScale(val, min, max, stops) {
        if (val == null || isNaN(val)) return '#1e2e45';
        const x = Math.max(0, Math.min(1, (val - min) / (max - min || 1)));
        for (let i = 1; i < stops.length; i++) {
            if (x <= stops[i][0]) return lerpColor(stops[i - 1][1], stops[i][1], (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
        }
        return stops[stops.length - 1][1];
    }
    function dirColor(deg) {
        if (deg == null || isNaN(deg)) return '#1e2e45';
        return `hsl(${(360 - deg + 210) % 360}, 70%, 55%)`;
    }

    /* =============== 1. spots map =============== */
    let smap = null, smarkers = [], sIdx = 0, sVar = 'rating', sPlay = null, sAxis = [];

    function coarseAxis() {
        const idx = S.index;
        const first = idx.spots[0];
        const n = first ? coarseCount(idx, first) : 0;
        const every = (idx.coarse && idx.coarse.every) || 3;
        const cutoff = new Date(); cutoff.setMinutes(0, 0, 0);
        const out = [];
        for (let ci = 0; ci < n; ci++) {
            const ms = indexHourMs(idx, ci * every);
            if (ms + every * 3600000 > cutoff.getTime()) out.push({ ci, ms });
        }
        return out;
    }
    function markerProps(h, v) {
        if (!h) return { color: '#1e2e45', radius: 4, label: '--' };
        switch (v) {
            case 'rating': { const k = ratingKey(h); return { color: RATING_COLORS[k], radius: 6, label: ratingLabel(k) }; }
            case 'wave_range': { const x = h.ml_wave_height_max || 0; return { color: colorScale(x, 0, 3, WAVE_SCALE), radius: Math.max(4, Math.min(9, 4 + x * 2)), label: `${fmtRange(h.ml_wave_height_min, h.ml_wave_height_max)} m` }; }
            case 'wave_sets': { const x = h.ml_wave_height_sets || h.ml_wave_height_max || 0; return { color: colorScale(x, 0, 3.5, WAVE_SCALE), radius: Math.max(4, Math.min(9, 4 + x * 1.8)), label: `${fmt(x)} m` }; }
            case 'surface': { const s = h.ml_surface; return { color: SURFACE_COLORS[s] || '#1e2e45', radius: 6, label: s ? surfaceLabel(s) : '--' }; }
            case 'wind_gust': { const x = h.wind_gusts_kmh || h.wind_speed_kmh || 0; return { color: colorScale(x, 0, 60, WIND_SCALE), radius: Math.max(4, Math.min(9, 4 + x / 10)), label: `${Math.round(x)} km/h` }; }
            case 'hs_offshore': { const x = h.wave_height_model || 0; return { color: colorScale(x, 0, 4, WAVE_SCALE), radius: Math.max(4, Math.min(9, 4 + x * 1.5)), label: `Hs ${fmt(x)} m` }; }
            case 'wave_period': { const x = h.peak_period || 0; return { color: colorScale(x, 4, 18, PERIOD_SCALE), radius: Math.max(4, Math.min(9, 4 + x / 4)), label: `${fmt(x, 0)} s` }; }
            case 'wind_speed': { const x = h.wind_speed_kmh || 0; return { color: colorScale(x, 0, 50, WIND_SCALE), radius: Math.max(4, Math.min(9, 4 + x / 8)), label: `${Math.round(x)} km/h` }; }
            case 'wind_dir': { const x = h.wind_speed_kmh || 0; return { color: dirColor(h.wind_direction), radius: Math.max(4, Math.min(9, 4 + x / 8)), label: `${compassLabel(h.wind_direction) || '--'} ${Math.round(x)} km/h` }; }
            case 'wave_dir': { const x = h.wave_height_model || 0; return { color: dirColor(h.wave_direction), radius: Math.max(4, Math.min(9, 4 + x * 1.5)), label: `${compassLabel(h.wave_direction) || '--'} ${fmt(x)} m` }; }
            default: return { color: '#1e2e45', radius: 4, label: '--' };
        }
    }
    function hourAt(entry) {
        const a = sAxis[sIdx];
        return a ? coarseHour(S.index, entry, a.ci) : null;
    }
    function updateSpotsTime() {
        const a = sAxis[sIdx];
        const el = $('map-time-display');
        el.textContent = a ? fmtInstant(a.ms, undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '--';
        const slider = $('map-time-slider');
        slider.setAttribute('aria-valuetext', el.textContent);
    }
    function updateSpotsMarkers() {
        const mobile = window.innerWidth < 600;
        for (const m of smarkers) {
            const p = markerProps(hourAt(m.entry), sVar);
            const sel = m.entry.id === S.current;
            m.marker.setStyle({ fillColor: p.color, radius: mobile ? Math.max(4, p.radius * 0.75) : p.radius, weight: sel ? 3 : 1, color: sel ? '#ffffff' : 'rgba(255,255,255,0.45)' });
            m.marker.setTooltipContent(`${escapeHtml(m.entry.name)} : ${escapeHtml(p.label)}`);
            if (sel) m.marker.bringToFront();
            if (m.marker.isPopupOpen()) m.marker.setPopupContent(popupHtml(m.entry));
        }
    }
    function updateSpotsLegend() {
        const legend = $('map-legend'), scale = $('map-scale-bar');
        const dots = rows => rows.map(([c, l]) => `<div class="map-legend-row"><span class="map-legend-dot" style="background:${c}"></span>${escapeHtml(l)}</div>`).join('');
        if (sVar === 'rating') {
            legend.hidden = false; scale.hidden = true;
            legend.innerHTML = dots([[RATING_COLORS.Good, ratingLabel('Good')], [RATING_COLORS.Fair, ratingLabel('Fair')], [RATING_COLORS.Poor, ratingLabel('Poor')], [RATING_COLORS.Flat, t('map.noData')]]);
        } else if (sVar === 'surface') {
            legend.hidden = false; scale.hidden = true;
            legend.innerHTML = dots([[SURFACE_COLORS.Clean, surfaceLabel('Clean')], [SURFACE_COLORS.Textured, surfaceLabel('Textured')], [SURFACE_COLORS.Messy, surfaceLabel('Messy')]]);
        } else if (sVar === 'wind_dir' || sVar === 'wave_dir') {
            legend.hidden = false; scale.hidden = true;
            legend.innerHTML = `<div class="map-legend-row" style="font-weight:700">${escapeHtml(t('map.fromDir'))}</div>` + dots([[dirColor(0), compassLabel(0)], [dirColor(90), compassLabel(90)], [dirColor(180), compassLabel(180)], [dirColor(270), compassLabel(270)]]);
        } else {
            legend.hidden = true; scale.hidden = false;
            const cfg = { wave_range: [WAVE_SCALE, 0, 3, 'm'], wave_sets: [WAVE_SCALE, 0, 3.5, 'm'], wave_period: [PERIOD_SCALE, 4, 18, 's'], wind_speed: [WIND_SCALE, 0, 50, 'km/h'], wind_gust: [WIND_SCALE, 0, 60, 'km/h'], hs_offshore: [WAVE_SCALE, 0, 4, 'm'] }[sVar] || [WAVE_SCALE, 0, 3, ''];
            $('map-scale-gradient').style.background = `linear-gradient(to right, ${cfg[0].map(s => `${s[1]} ${s[0] * 100}%`).join(', ')})`;
            $('map-scale-labels').innerHTML = `<span>${fmt(cfg[1], 0)} ${cfg[3]}</span><span>${fmt(cfg[2], cfg[2] % 1 ? 1 : 0)} ${cfg[3]}</span>`;
        }
    }
    function popupHtml(entry) {
        const a = sAxis[sIdx];
        if (!a) return '';
        const h = coarseHour(S.index, entry, a.ci);
        const key = ratingKey(h);
        const bars = [];
        const upcoming = sAxis.slice(sIdx, sIdx + 12);
        const maxW = Math.max(0.1, ...upcoming.map(x => coarseHour(S.index, entry, x.ci).ml_wave_height_max || 0));
        upcoming.forEach((x, i) => {
            const hh = coarseHour(S.index, entry, x.ci);
            const k = ratingKey(hh);
            const w = hh.ml_wave_height_max || 0;
            const p = zonedParts(x.ms, entry.tz);
            bars.push(`<div class="popup-hour"${i === 0 ? ' style="border-bottom:2px solid #0d1e36"' : ''}><span class="ph-time">${escapeHtml(hourLabel(p.hour))}</span><div class="ph-bar" style="background:${RATING_COLORS[k]};height:${Math.max(4, Math.round(w / maxW * 30))}px"></div><span class="ph-wave">${w > 0 ? fmt(w) : '-'}</span></div>`);
        });
        const txt = key === 'Poor' || key === 'Flat' ? '#fff' : '#000';
        return `<div class="map-spot-popup">
            <div class="popup-header">
                <button type="button" class="popup-name" data-open-spot="${escapeHtml(entry.id)}" data-time="${escapeHtml(h.time)}">${escapeHtml(entry.name)}</button>
                <span class="popup-best" style="background:${RATING_COLORS[key]};color:${txt}">${escapeHtml(ratingLabel(key))}</span>
            </div>
            <div class="popup-time">${escapeHtml(fmtInstant(a.ms, entry.tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</div>
            <div class="popup-grid">
                <div>${escapeHtml(t('map.waves'))} <b>${h.ml_wave_height_max != null ? escapeHtml(fmtRange(h.ml_wave_height_min, h.ml_wave_height_max)) + ' m' : '--'}</b>${h.ml_wave_height_sets != null ? ` <span style="color:#0369a1;font-weight:700">&uarr;${escapeHtml(fmt(h.ml_wave_height_sets))}</span>` : ''}</div>
                <div>${escapeHtml(t('map.surface'))} <b>${escapeHtml(h.ml_surface ? surfaceLabel(h.ml_surface) : '--')}</b></div>
                <div>${escapeHtml(t('map.wind'))} <b>${escapeHtml(compassLabel(h.wind_direction))} ${h.wind_speed_kmh != null ? Math.round(h.wind_speed_kmh) + ' km/h' : '--'}</b></div>
                <div>${escapeHtml(t('map.gusts'))} <b>${h.wind_gusts_kmh != null ? Math.round(h.wind_gusts_kmh) + ' km/h' : '--'}</b></div>
            </div>
            <div class="popup-hourly" aria-label="${escapeHtml(t('map.next36h'))}">${bars.join('')}</div>
            <button type="button" class="popup-link" data-open-spot="${escapeHtml(entry.id)}" data-time="${escapeHtml(h.time)}">${escapeHtml(t('map.viewForecast'))} &rarr;</button>
        </div>`;
    }
    function buildSpotsMarkers() {
        smarkers.forEach(m => m.marker.remove());
        smarkers = [];
        sAxis = coarseAxis();
        const now = Date.now();
        sIdx = 0;
        let best = Infinity;
        sAxis.forEach((a, i) => { const d = Math.abs(a.ms - now); if (d < best) { best = d; sIdx = i; } });
        const slider = $('map-time-slider');
        slider.max = String(Math.max(0, sAxis.length - 1));
        slider.value = String(sIdx);
        for (const entry of S.index.spots) {
            if (entry.lat == null || entry.lon == null) continue;
            const marker = L.circleMarker([entry.lat, entry.lon], { radius: 5, fillColor: '#1e2e45', color: 'rgba(255,255,255,0.45)', weight: 1, fillOpacity: 0.9 }).addTo(smap);
            marker.bindTooltip(escapeHtml(entry.name), { direction: 'top', offset: [0, -6] });
            marker.bindPopup(() => popupHtml(entry), { maxWidth: 420 });
            smarkers.push({ entry, marker });
        }
        updateSpotsTime();
        updateSpotsMarkers();
        updateSpotsLegend();
    }
    function stopSpotsPlay() {
        if (sPlay) clearInterval(sPlay);
        sPlay = null;
        const b = $('map-play');
        b.textContent = '▶';
        b.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-label', t('map.play'));
    }
    function toggleSpotsPlay() {
        if (sPlay) { stopSpotsPlay(); return; }
        const b = $('map-play');
        b.textContent = '❚❚';
        b.setAttribute('aria-pressed', 'true');
        b.setAttribute('aria-label', t('map.pause'));
        sPlay = setInterval(() => {
            sIdx = (sIdx + 1) % Math.max(1, sAxis.length);
            $('map-time-slider').value = String(sIdx);
            updateSpotsTime();
            updateSpotsMarkers();
        }, 500);
    }
    function showSpots() {
        if (!S.index) return;
        if (!smap) {
            smap = L.map('conditions-map', { scrollWheelZoom: false, zoomControl: true }).setView([44.5, -2.5], 5);
            L.tileLayer(TILE_DARK, { attribution: TILE_ATTR, maxZoom: 12, minZoom: 3 }).addTo(smap);
            L.tileLayer(TILE_DARK_LABELS, { maxZoom: 12, minZoom: 3 }).addTo(smap);
            $('map-variable').addEventListener('change', e => { sVar = e.target.value; updateSpotsMarkers(); updateSpotsLegend(); });
            $('map-time-slider').addEventListener('input', e => { stopSpotsPlay(); sIdx = Number(e.target.value) || 0; updateSpotsTime(); updateSpotsMarkers(); });
            $('map-play').addEventListener('click', toggleSpotsPlay);
            $('conditions-map').addEventListener('click', e => {
                const b = e.target.closest('[data-open-spot]');
                if (!b) return;
                smap.closePopup();
                switchView('forecast');
                openSpot(b.dataset.openSpot, { focusTime: b.dataset.time });
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            buildSpotsMarkers();
            const cur = currentEntry();
            if (cur && cur.lat != null) smap.setView([cur.lat, cur.lon], 6, { animate: false });
        }
        setTimeout(() => smap.invalidateSize(), 0);
    }

    /* =============== 2. ocean map =============== */
    // Lives in ocean.js (canvas swell field + particles), loaded on first use.
    let ocean = null;
    function showOcean() {
        if (!S.index) return Promise.resolve();
        return loadScript(assetUrl('ocean.js')).then(() => { ocean = window.Ocean; ocean.show(); });
    }

    /* =============== hooks =============== */
    function onSpotChanged() {
        if (smap) updateSpotsMarkers();
        if (ocean) ocean.onSpotChanged();
    }
    function onIndexChanged() {
        if (smap) buildSpotsMarkers();
        if (ocean) ocean.onIndexChanged();
    }
    function relabel() {
        if (smap) { updateSpotsTime(); updateSpotsMarkers(); updateSpotsLegend(); stopSpotsPlay(); }
        if (ocean) ocean.relabel();
    }
    function stop() {
        if (smap) stopSpotsPlay();
        if (ocean) ocean.stop();
    }
    const TILES = { dark: TILE_DARK, darkLabels: TILE_DARK_LABELS, attr: TILE_ATTR };
    return { showSpots, showOcean, onSpotChanged, onIndexChanged, relabel, stop, TILES, RATING_COLORS };
})();
window.Maps = Maps;
