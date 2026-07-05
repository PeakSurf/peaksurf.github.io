/* PeakSurf /next/ — shared helpers (classic script, globals on purpose:
   no build step; later scripts call these directly).
   Depends on i18n.js (t, getLang, getLocale). */
'use strict';

/* ---------- numbers ---------- */
const _numFmtCache = new Map();
function _numFmt(decimals) {
    const key = getLocale() + '|' + decimals;
    let f = _numFmtCache.get(key);
    if (!f) {
        f = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
        _numFmtCache.set(key, f);
    }
    return f;
}
/** Locale-aware fixed-decimals formatting ("1,2" in French). '--' for null. */
function fmt(val, decimals = 1) {
    if (val == null || val === '' || !Number.isFinite(Number(val))) return '--';
    return _numFmt(decimals).format(Number(val));
}
function fmtRange(min, max, decimals = 1) {
    if (max == null) return '--';
    if (min == null || Math.abs(max - min) < 0.1) return fmt(max, decimals);
    return `${fmt(min, decimals)}–${fmt(max, decimals)}`;
}
function fmtPct(fraction, decimals = 0) {
    if (fraction == null || !Number.isFinite(Number(fraction))) return '--';
    return new Intl.NumberFormat(getLocale(), { style: 'percent', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Number(fraction));
}
function fmtInt(n) {
    if (n == null || !Number.isFinite(Number(n))) return '--';
    return new Intl.NumberFormat(getLocale()).format(Math.round(Number(n)));
}
function mapFinite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/* ---------- time ---------- */
function parseUtcMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    return Date.parse(v);
}
const _partsFmtCache = new Map();
const _partsCache = new Map();
/** Wall-clock parts of an instant in a time zone (numbers only, locale-free). */
function zonedParts(msOrIso, tz) {
    const ms = parseUtcMs(msOrIso);
    const zone = tz || 'UTC';
    const key = zone + '|' + ms;
    const hit = _partsCache.get(key);
    if (hit) return hit;
    let f = _partsFmtCache.get(zone);
    if (!f) {
        try {
            f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        } catch (e) {
            f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        }
        _partsFmtCache.set(zone, f);
    }
    const p = {};
    for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = part.value;
    const r = { year: +p.year, month: +p.month, day: +p.day, hour: (+p.hour) % 24, minute: +p.minute };
    r.date = `${r.year}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`;
    if (_partsCache.size > 20000) _partsCache.clear();
    _partsCache.set(key, r);
    return r;
}
function spotTz(spot) { return (spot && (spot.timezone || spot.tz)) || 'UTC'; }
function spotLocalParts(msOrIso, spot) { return zonedParts(msOrIso, spotTz(spot)); }
function spotLocalDateStr(msOrIso, spot) { return zonedParts(msOrIso, spotTz(spot)).date; }
function todayStrFor(spot) { return spotLocalDateStr(Date.now(), spot); }
function pad2(n) { return String(n).padStart(2, '0'); }
/** "14h" / "14 h" style hour label. */
function hourLabel(h) { return t('fmt.hour', { h: getLang() === 'fr' ? h : pad2(h) }); }
function hhmm(parts) { return `${pad2(parts.hour)}:${pad2(parts.minute)}`; }

const _dateFmtCache = new Map();
function _dateFmt(opts) {
    const key = getLocale() + JSON.stringify(opts);
    let f = _dateFmtCache.get(key);
    if (!f) { f = new Intl.DateTimeFormat(getLocale(), opts); _dateFmtCache.set(key, f); }
    return f;
}
/** Localised label for a calendar date string 'YYYY-MM-DD' (no tz shift). */
function fmtDate(dateStr, opts) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return _dateFmt({ ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
function weekdayShort(dateStr) { return fmtDate(dateStr, { weekday: 'short' }); }
function dayMonth(dateStr) { return fmtDate(dateStr, { day: 'numeric', month: 'numeric' }); }
/** Instant formatted in a zone, e.g. "sam. 27 sept., 14:00". */
function fmtInstant(msOrIso, tz, opts) {
    const ms = parseUtcMs(msOrIso);
    if (!Number.isFinite(ms)) return '--';
    try {
        return _dateFmt({ hourCycle: 'h23', ...opts, timeZone: tz || 'UTC' }).format(new Date(ms));
    } catch (e) {
        return new Date(ms).toISOString();
    }
}
function fmtRelativeAge(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' });
    if (minutes < 60) return rtf.format(-minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 48) return rtf.format(-hours, 'hour');
    return rtf.format(-Math.round(hours / 24), 'day');
}
/** "Aujourd'hui" / "Demain" / "sam. 27/9" for a local date string. */
function localDayLabel(dateStr, spot) {
    const today = todayStrFor(spot);
    if (dateStr === today) return t('day.today');
    const [y, m, d] = today.split('-').map(Number);
    const [y2, m2, d2] = dateStr.split('-').map(Number);
    const diff = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y, m - 1, d)) / 86400000);
    if (diff === 1) return t('day.tomorrow');
    return `${weekdayShort(dateStr)} ${dayMonth(dateStr)}`;
}

/* ---------- directions ---------- */
const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** Canonical (English) 16-point label — same binning as scripts/web_export.py. */
function degToCompass(deg) {
    if (deg == null || isNaN(deg)) return '';
    return COMPASS_16[Math.round(Number(deg) / 22.5) % 16];
}
/** Localised compass label (French uses O for ouest). */
function compassLabel(deg) {
    const c = degToCompass(deg);
    if (!c) return '';
    return getLang() === 'fr' ? c.replace(/W/g, 'O') : c;
}
function travelBearing(deg) { return (Number(deg) + 180) % 360; }
function arrowSvg(bearing, size, label) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${escapeHtml(label)}" style="transform:rotate(${bearing}deg)"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="5 12 12 5 19 12"></polyline></svg>`;
}
/** "↑ From W 281° → E" inline markup (arrow shows travel direction). */
function directionMarkup(direction, options = {}) {
    const has = direction != null && !isNaN(direction);
    if (!has) return '--';
    const showDegrees = options.showDegrees !== false;
    const size = options.size || 12;
    const travel = compassLabel(travelBearing(direction));
    const parts = [t('dir.from', { dir: compassLabel(direction) })];
    if (showDegrees) parts.push(`<span class="deg">${Math.round(direction)}&deg;</span>`);
    parts.push(`<span class="direction-travel">→ ${travel}</span>`);
    return `<span class="direction-inline">${arrowSvg(travelBearing(direction), size, t('dir.travelsToward', { dir: travel }))}<span>${parts.join(' ')}</span></span>`;
}
function _angleDiff(a, b) {
    if (a == null || b == null) return null;
    return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180);
}
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/* ---------- ratings (source of truth: ML rating) ---------- */
function getNormalizedConseil(h) {
    if (!h || !h.ml_conseil) return null;
    const c = String(h.ml_conseil).toLowerCase();
    if (c.includes('epic') || c.includes('excellent')) return 'Epic';
    if (c.includes('good')) return 'Good';
    if (c.includes('fair') || c.includes('average')) return 'Fair';
    if (c.includes('poor') || c.includes('bad')) return 'Poor';
    return h.ml_conseil;
}
/** CSS tier: good | fair | poor | flat (Epic collapses into good). */
function getRatingColor(h) {
    const c = getNormalizedConseil(h);
    if (c === 'Epic' || c === 'Good') return 'good';
    if (c === 'Fair') return 'fair';
    if (c === 'Poor') return 'poor';
    if (h && h.rating) {
        const r = String(h.rating).toLowerCase();
        if (r.includes('good') || r.includes('epic')) return 'good';
        if (r.includes('fair')) return 'fair';
        if (r.includes('poor')) return 'poor';
    }
    return 'flat';
}
/** Normalised rating key of an hour: Good | Fair | Poor | Flat. */
function ratingKey(h) {
    const c = getNormalizedConseil(h);
    if (c === 'Epic' || c === 'Good') return 'Good';
    if (c === 'Fair' || c === 'Poor') return c;
    const tier = getRatingColor(h);
    return tier === 'flat' ? 'Flat' : tier.charAt(0).toUpperCase() + tier.slice(1);
}
function ratingLabel(key) { return t('rating.' + (key || 'Flat')); }
function ratingTextColor(tier) { return (tier === 'good' || tier === 'fair' || tier === 'epic') ? '#000' : '#fff'; }
const RATING_CHAR_KEY = { G: 'Good', F: 'Fair', P: 'Poor', '-': 'Flat' };
const RATING_CHAR_TIER = { G: 'good', F: 'fair', P: 'poor', '-': 'flat' };

function getConfidenceMeta(conf) {
    if (conf == null || isNaN(conf)) return { key: null, color: 'var(--text-light)' };
    if (conf > 0.5) return { key: 'high', color: '#10b981' };
    if (conf > 0.3) return { key: 'medium', color: '#f59e0b' };
    return { key: 'low', color: '#ef4444' };
}
function surfaceLabel(s) {
    if (!s) return '';
    const k = String(s).toLowerCase();
    return ['clean', 'textured', 'messy'].includes(k) ? t('surface.' + k) : s;
}
function skillLabel(s) { return s === 'Confirmés+' ? t('skill.advanced') : t('skill.all'); }
function tideTrendLabel(trend) {
    if (!trend) return '';
    return ['rising', 'falling', 'slack'].includes(trend) ? t('tide.' + trend) : trend;
}
function tideIssueLabel(issue) {
    if (!issue) return '';
    const map = { 'high tide, too deep': 'tide.issueHigh', 'low tide closeout risk': 'tide.issueLow' };
    return map[issue] ? t(map[issue]) : issue;
}

function isDaylight(h, spot) {
    if (h.is_day != null) return h.is_day === 1;
    const hr = spotLocalParts(h.time, spot).hour;
    return hr >= 6 && hr <= 20;
}

/** Wind relative to the beach: offshore / cross-off / cross / cross-on / onshore. */
function getWindEffect(h, spot) {
    if (h.wind_speed_kmh == null || h.wind_direction == null) return { key: null, label: '--' };
    const shoreNormal = (spot && spot.shore_normal != null) ? spot.shore_normal : 270;
    const offshoreDir = (shoreNormal + 180) % 360;
    const offDiff = _angleDiff(h.wind_direction, offshoreDir);
    const onDiff = _angleDiff(h.wind_direction, shoreNormal);
    let key;
    if (offDiff < 30) key = 'offshore';
    else if (offDiff < 60) key = 'crossOff';
    else if (onDiff < 30) key = 'onshore';
    else if (onDiff < 60) key = 'crossOn';
    else key = 'cross';
    return { key, label: t('wind.' + key) };
}
function windEffectColor(key) {
    if (key === 'offshore' || key === 'crossOff') return '#10b981';
    if (key === 'onshore' || key === 'crossOn') return '#ef4444';
    return '#94a3b8';
}
/** Fallback surface description from wind when the ML surface is absent. */
function getSurfaceTexture(h, spot) {
    if (h.wind_speed_kmh == null || h.wind_direction == null) return t('surface.unknown');
    const speed = h.wind_speed_kmh;
    const effect = getWindEffect(h, spot).key || '';
    if (speed < 5) return t('surface.glassy');
    if (effect.startsWith('offshore') || effect === 'crossOff') return speed > 25 ? t('surface.strongOffshore') : t('surface.clean');
    if (effect === 'cross') return speed < 12 ? t('surface.textured') : speed < 22 ? t('surface.choppy') : t('surface.messy');
    return speed < 10 ? t('surface.lightChop') : speed < 18 ? t('surface.choppy') : t('surface.blownOut');
}

/* ---------- best-period scoring (mirrors scripts/web_export.py) ---------- */
function getBestMomentMlScore(h) {
    const p = h.ml_conseil_proba || {};
    const getP = k => p[k] || p[k.toLowerCase()] || 0;
    return getP('Epic') * 3 + getP('Good') * 2 + getP('Fair') * 1 - getP('Poor') * 1 + (h.ml_wave_height_max || 0) * 0.1;
}
function getBestPeriodSurfaceAdjustment(h) {
    const surface = String(h.ml_surface || '').toLowerCase().trim();
    const conf = Number(h.ml_surface_conf || 0);
    if (surface === 'clean') return 0.35 * conf;
    if (surface === 'textured') return -0.05 * conf;
    if (surface === 'messy') return -0.60 * conf;
    return 0;
}
function getBestPeriodHourScore(h) { return getBestMomentMlScore(h) + getBestPeriodSurfaceAdjustment(h); }

/* ---------- storage (never throws) ---------- */
function storeGet(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function storeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode / quota */ }
}
