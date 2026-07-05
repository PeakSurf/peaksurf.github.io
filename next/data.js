/* PeakSurf /next/ — data layer.
   Contract: scripts/web_export.py (schema v2), documented in README.md.
     <dataBase>index.json         all spots, coarse 7-day summary (first paint)
     <dataBase>spots/<id>.json    one spot, full hourly, columnar
     <statusUrl>                  {generated_at, deployed_at, model_accuracy?}
   Requests for index/spot files carry ?v=<generated_at> so the service worker
   can serve them from cache until a new forecast is published. */
'use strict';

const CFG = Object.assign({
    dataBase: '../data/v2/',
    statusUrl: '../data/status.json',
    climatoUrl: '../data/climato_summary.json',
    oceanUrl: '../data/ocean/latest.json',
    cameraStreamsUrl: '../live-preview/camera-streams.js',
    cameraPlayerUrl: '../live-preview/player.html',
    staleAfterHours: 12,
    fetchTimeoutMs: 15000,
}, window.PEAKSURF_CONFIG || {});
if (!/\/$/.test(CFG.dataBase)) CFG.dataBase += '/';

const SUPPORTED_SCHEMA = 2;

class DataError extends Error {
    constructor(kind, message, status) {
        super(message);
        this.kind = kind;       // 'network' | 'http' | 'schema' | 'notfound'
        this.status = status || 0;
    }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** fetch + JSON with timeout and retries on network errors / 5xx.
    Resolves to {data, offline, gen}: `offline` is set when the service
    worker answered from its cache because the network failed. */
async function fetchJson(url, { retries = 2, timeoutMs = CFG.fetchTimeoutMs, cache = 'default' } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt) await _sleep(600 * attempt * attempt);
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        let res;
        try {
            res = await fetch(url, { cache, signal: ctrl ? ctrl.signal : undefined });
        } catch (e) {
            if (timer) clearTimeout(timer);
            lastErr = new DataError('network', (e && e.message) || 'Network error');
            continue;
        }
        if (!res.ok) {
            if (timer) clearTimeout(timer);
            const err = new DataError(res.status === 404 ? 'notfound' : 'http', `HTTP ${res.status} ${url}`, res.status);
            if (res.status >= 500) { lastErr = err; continue; }
            throw err;
        }
        let data;
        try {
            data = await res.json();
        } catch (e) {
            if (e && e.name === 'AbortError') { lastErr = new DataError('network', 'Timeout'); continue; }
            throw new DataError('schema', `Invalid JSON ${url}`);
        } finally {
            if (timer) clearTimeout(timer);
        }
        return { data, offline: res.headers.get('x-ps-offline') === '1', gen: res.headers.get('x-ps-gen') || null };
    }
    throw lastErr || new DataError('network', 'Network error');
}

function withVersion(url, gen) {
    if (!gen) return url;
    return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(gen);
}

/* ---------- status ---------- */
async function loadStatus() {
    const r = await fetchJson(CFG.statusUrl, { retries: 1, timeoutMs: 8000, cache: 'no-cache' });
    if (!r.data || typeof r.data !== 'object') throw new DataError('schema', 'status.json is not an object');
    return r;
}

/* ---------- index ---------- */
async function loadIndex(gen) {
    const r = await fetchJson(withVersion(CFG.dataBase + 'index.json', gen));
    const idx = r.data;
    if (!idx || idx.v !== SUPPORTED_SCHEMA || !Array.isArray(idx.spots)) {
        throw new DataError('schema', `index.json schema ${idx && idx.v} unsupported`);
    }
    idx.byId = {};
    for (const s of idx.spots) idx.byId[s.id] = s;
    if (!Array.isArray(idx.spot_order)) idx.spot_order = idx.spots.map(s => s.id);
    return { index: idx, offline: r.offline };
}

function indexHourMs(idx, i) { return (idx.t0 + i * idx.step) * 1000; }

/** Pseudo-hour record built from the coarse index series (every N hours),
    with the same field names as a full hourly record. */
function coarseHour(idx, entry, ci) {
    const c = entry.c || {};
    const sc = (idx.coarse && idx.coarse.scale) || {};
    const every = (idx.coarse && idx.coarse.every) || 3;
    const v = k => (c[k] && c[k][ci] != null) ? c[k][ci] / (sc[k] || 1) : null;
    const hi = ci * every;
    const rc = entry.r ? entry.r[hi] : '-';
    const sf = c.sf ? c.sf[ci] : '-';
    const d = entry.d ? entry.d[hi] : null;
    return {
        time: new Date(indexHourMs(idx, hi)).toISOString().replace('.000Z', 'Z'),
        _ms: indexHourMs(idx, hi),
        ml_conseil: RATING_CHAR_KEY[rc] === 'Flat' ? null : RATING_CHAR_KEY[rc],
        ml_surface: sf === 'C' ? 'Clean' : sf === 'T' ? 'Textured' : sf === 'M' ? 'Messy' : null,
        ml_wave_height_min: v('fmin'),
        ml_wave_height_max: v('fmax'),
        ml_wave_height_sets: v('sets'),
        wave_height_model: v('hs'),
        peak_period: v('tp'),
        wave_direction: v('wd'),
        wind_speed_kmh: v('ws'),
        wind_gusts_kmh: v('wg'),
        wind_direction: v('wn'),
        is_day: d == null ? null : Number(d),
    };
}
function coarseCount(idx, entry) {
    const c = entry.c || {};
    const first = Object.keys(c).find(k => Array.isArray(c[k]));
    return first ? c[first].length : 0;
}

/* ---------- one spot ---------- */
const DIRECTION_BASES = ['wave', 'swell', 'swell2', 'wind_wave', 'wind'];

function isoZ(ms) { return new Date(ms).toISOString().replace('.000Z', 'Z'); }

/** Columnar payload → {spot, hourly[], daily[], tides[]} with the same
    field names as the legacy forecast.json (mirrors web_export.decode_spot). */
function hydrateSpot(p) {
    if (!p || p.v !== SUPPORTED_SCHEMA || !p.cols) throw new DataError('schema', `spot schema ${p && p.v} unsupported`);
    const n = p.n || 0;
    const times = p.times || Array.from({ length: n }, (_, i) => p.t0 + i * p.step);
    const cols = p.cols, scale = p.scale || {}, enums = p.enums || {};
    const names = Object.keys(cols);
    const hourly = new Array(n);
    for (let i = 0; i < n; i++) {
        const ms = times[i] * 1000;
        const h = { time: isoZ(ms), _ms: ms };
        for (const name of names) {
            const raw = cols[name][i];
            let val = null;
            if (raw != null) val = enums[name] ? enums[name][raw] : raw / (scale[name] || 1);
            const dot = name.indexOf('.');
            if (dot > 0) {
                if (val == null) continue;
                const parent = name.slice(0, dot);
                (h[parent] || (h[parent] = {}))[name.slice(dot + 1)] = val;
            } else {
                h[name] = val;
            }
        }
        for (const base of DIRECTION_BASES) {
            const deg = h[base + '_direction'];
            if (deg != null) h[base + '_direction_text'] = degToCompass(deg);
        }
        hourly[i] = h;
    }
    const tides = (p.tides || []).map(([s, typ, hgt]) => ({ datetime: isoZ(s * 1000), ms: s * 1000, type: typ === 'h' ? 'high' : 'low', height: hgt }));
    const spot = Object.assign({}, p.spot || {}, { id: p.id });
    return { id: p.id, generated_at: p.generated_at, spot, hourly, daily: p.daily || [], tides };
}

const _spotCache = new Map();   // id|gen → hydrated
async function loadSpot(id, gen) {
    const key = id + '|' + (gen || '');
    if (_spotCache.has(key)) return { spotData: _spotCache.get(key), offline: false };
    const r = await fetchJson(withVersion(CFG.dataBase + 'spots/' + encodeURIComponent(id) + '.json', gen));
    const spotData = hydrateSpot(r.data);
    _spotCache.set(key, spotData);
    while (_spotCache.size > 12) _spotCache.delete(_spotCache.keys().next().value);
    return { spotData, offline: r.offline };
}
