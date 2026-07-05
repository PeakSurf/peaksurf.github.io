/* PeakSurf /next/ — spot forecast view (ported from web/classic-live).
   Renders from:
     - the index entry (coarse, instant): header, 7-day cards, skeletons
     - the hydrated spot file (full): hero, cards, hourly track, tide curve */
'use strict';

/* Shared app state (read by app.js / maps.js / climato.js). */
const S = {
    index: null,          // index.json (+ byId)
    status: null,         // status.json
    gen: null,            // generated_at used to version data requests
    current: null,        // current spot id
    spotData: null,       // hydrated spot file of the current spot
    hourly: [],           // visible (current hour onwards) hourly records
    tides: [],
    daily: [],
    selectedIdx: -1,
    activeDate: null,
    offline: false,
};

const NEARBY_RADIUS_OPTS = [20, 40, 60, 80, 100];
const NEARBY_KEY = 'peaksurf_nearby_radius_km';
let _nearbyRadiusKm = (() => {
    const v = parseInt(storeGet(NEARBY_KEY), 10);
    return NEARBY_RADIUS_OPTS.includes(v) ? v : 80;
})();
const MIN_SCORE_GAIN = 3;       // candidate day must beat the local one by this much
const DISTANCE_PENALTY = 0.03;  // score points per km

function $(id) { return document.getElementById(id); }
function currentEntry() { return S.index && S.current ? S.index.byId[S.current] : null; }
function currentSpotMeta() {
    if (S.spotData) return S.spotData.spot;
    const e = currentEntry();
    return e ? { id: e.id, name: e.name, region: e.region, lat: e.lat, lon: e.lon, timezone: e.tz, shore_normal: e.sn } : null;
}

function getVisibleForecastHours(spotData) {
    const hourly = (spotData && spotData.hourly) || [];
    if (!hourly.length) return [];
    const cutoff = new Date(); cutoff.setMinutes(0, 0, 0);
    const visible = hourly.filter(h => h._ms >= cutoff.getTime());
    return visible.length ? visible : hourly;
}
function findClosestHour(hourly, ms = Date.now()) {
    let best = hourly[0], bestD = Infinity, bestI = 0;
    hourly.forEach((h, i) => { const d = Math.abs(h._ms - ms); if (d < bestD) { bestD = d; best = h; bestI = i; } });
    return { h: best, i: bestI };
}

/* ---------- slot geometry ---------- */
function _cssPx(name, fallback) {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
}
function getHourlySlotWidth() { return _cssPx('--hour-slot-width', 78); }
function getHourlyRowLabelWidth() { return _cssPx('--hour-row-label-width', 72); }
function getHourlyWaveSlot(index) { return document.querySelector(`#wave-bars .wave-slot[data-index="${index}"]`); }
function getHourlyScrollLeft(index, scroller, alignStart = false) {
    const slotW = getHourlySlotWidth(), labelW = getHourlyRowLabelWidth();
    const x = labelW + index * slotW;
    return Math.max(0, alignStart ? x - labelW : x - scroller.clientWidth / 2 + slotW / 2);
}

/* ---------- tides ---------- */
function getTideSnapshotAt(timeMs, tides = S.tides) {
    const extrema = (tides || []).filter(td => Number.isFinite(td.ms) && Number.isFinite(Number(td.height)));
    let before = null, after = null;
    for (const td of extrema) {
        if (td.ms <= timeMs) before = td;
        if (td.ms > timeMs) { after = td; break; }
    }
    if (!before || !after || before.ms === after.ms) return null;
    const progress = Math.max(0, Math.min(1, (timeMs - before.ms) / (after.ms - before.ms)));
    const eased = (1 - Math.cos(progress * Math.PI)) / 2;
    const height = Number(before.height) + (Number(after.height) - Number(before.height)) * eased;
    const minutesToTurn = Math.round((after.ms - timeMs) / 60000);
    const trend = after.type === 'high' ? 'rising' : 'falling';
    const label = minutesToTurn <= 15 ? t('tide.nearTurn') : tideTrendLabel(trend);
    return { height, trend, label, minutesToTurn, next: after };
}
function tideScoreBadge(h, small) {
    const ts = h && h.physics_fit && h.physics_fit.tide_score;
    if (ts == null) return '';
    const s = Math.round(ts);
    const c = s >= 65 ? '#16a34a' : s >= 40 ? '#94a3b8' : '#dc2626';
    return ` <span class="small-badge" style="color:${c}">${escapeHtml(t('tide.score', { s }))}</span>`;
}

/* ---------- header ---------- */
function renderSpotHeader() {
    const e = currentEntry();
    const name = $('spot-name');
    if (e) {
        name.textContent = e.name;
        name.classList.remove('skeleton');
    }
    const spot = S.spotData && S.spotData.spot;
    const region = (spot && spot.region) || (e && e.region) || '';
    const bathy = spot && spot.bathy_info;
    $('spot-desc').textContent = region + (bathy ? ' — ' + bathy : '');
    updateFavToggle();
    if (e) document.title = t('meta.titleSpot', { name: e.name });
}

/* ---------- hero ---------- */
function renderHeroLoading() {
    $('conditions-summary').classList.add('is-loading');
    ['hero-height', 'hero-wind', 'hero-swell', 'hero-period', 'hero-tide', 'hero-sst'].forEach(id => { $(id).textContent = '--'; });
    ['hero-wave-detail', 'hero-ai-detail', 'hero-wind-detail', 'hero-swell-detail', 'hero-tide-trend', 'hero-sst-suit'].forEach(id => { $(id).innerHTML = '<span class="skeleton skeleton-line" style="width:80%"></span>'; });
    const rb = $('hero-rating');
    rb.textContent = '--';
    rb.style.background = 'var(--flat)';
    rb.style.color = '#fff';
    $('hero-confidence').hidden = true;
}

function renderHero() {
    const sd = S.spotData;
    if (!sd || !sd.hourly.length) return;
    $('conditions-summary').classList.remove('is-loading');
    const { h, i } = findClosestHour(sd.hourly);
    const spot = sd.spot;
    const key = ratingKey(h);
    const tier = getRatingColor(h);
    const rb = $('hero-rating');
    rb.textContent = ratingLabel(key);
    rb.style.background = `var(--${tier})`;
    rb.style.color = ratingTextColor(tier);

    const conf = getConfidenceMeta(h.ml_conseil_conf);
    const cb = $('hero-confidence');
    if (conf.key) {
        cb.hidden = false;
        cb.textContent = t('conf.' + conf.key);
        cb.style.color = conf.color;
    } else {
        cb.hidden = true;
    }

    let trendIcon = '';
    const next = sd.hourly[i + 1];
    if (next) {
        const cur = h.ml_wave_height_max || 0, nxt = next.ml_wave_height_max || 0;
        if (nxt > cur + 0.1) trendIcon = ` <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${escapeHtml(t('hero.building'))}" style="display:inline-block;vertical-align:-3px;color:var(--accent)"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>`;
        else if (nxt < cur - 0.1) trendIcon = ` <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${escapeHtml(t('hero.dropping'))}" style="display:inline-block;vertical-align:-3px;color:var(--text-muted)"><line x1="7" y1="7" x2="17" y2="17"></line><polyline points="17 7 17 17 7 17"></polyline></svg>`;
    }
    $('hero-height').innerHTML = escapeHtml(fmtRange(h.ml_wave_height_min, h.ml_wave_height_max)) + trendIcon;

    const sets = h.ml_wave_height_sets != null ? h.ml_wave_height_sets : h.ml_wave_height_max;
    const wd = $('hero-wave-detail');
    if (sets != null) { wd.className = 'hero-set-badge'; wd.textContent = t('hero.setsUpTo', { v: fmt(sets) }); }
    else { wd.className = 'hero-desc'; wd.textContent = ''; }

    const surface = h.ml_surface ? surfaceLabel(h.ml_surface) : getSurfaceTexture(h, spot);
    const showSkill = key !== 'Poor';
    $('hero-ai-detail').innerHTML = `<div><span style="font-weight:600;color:var(--text-dark)">${escapeHtml(surface)}</span>${showSkill ? ' &bull; ' + escapeHtml(skillLabel(h.ml_skill)) : ''}</div>`;

    $('hero-swell').textContent = fmt(h.wave_height_model);
    $('hero-period').textContent = fmt(h.peak_period, 0);
    $('hero-swell-detail').innerHTML = directionMarkup(h.wave_direction);

    const effect = getWindEffect(h, spot);
    $('hero-wind').textContent = fmt(h.wind_speed_kmh, 0);
    $('hero-wind-detail').innerHTML = `${directionMarkup(h.wind_direction)} &middot; ${escapeHtml(effect.label)}${h.wind_gusts_kmh != null ? ' &middot; ' + escapeHtml(t('wind.gustsKmh', { v: fmt(h.wind_gusts_kmh, 0) })) : ''}`;

    $('hero-sst').textContent = fmt(h.sst, 1);
    const sst = h.sst || 0;
    $('hero-sst-suit').textContent = h.sst == null ? '' : t(sst < 14 ? 'sst.w43' : sst < 18 ? 'sst.w32' : sst < 22 ? 'sst.shorty' : 'sst.boardshorts');

    const tideNow = getTideSnapshotAt(Date.now());
    const tideHeight = tideNow ? tideNow.height : h.tide_height;
    $('hero-tide').textContent = tideHeight != null ? fmt(tideHeight) : '--';
    $('hero-tide-trend').textContent = (tideNow && tideNow.label) || tideTrendLabel(h.tide_trend) || '';
}

/* ---------- best 3 h window (per day) ---------- */
function collectBestWindowCandidates(dayHours, spot, length) {
    const out = [];
    for (let s = 0; s + length < dayHours.length; s++) {
        const endBoundary = dayHours[s + length];
        if (!endBoundary || !isDaylight(endBoundary, spot)) continue;
        const win = dayHours.slice(s, s + length);
        if (win.length !== length || win.some(h => !isDaylight(h, spot) || h.ml_wave_height_max == null)) continue;
        const scores = win.map(getBestPeriodHourScore);
        let peak = 0;
        for (let k = 1; k < scores.length; k++) if (scores[k] > scores[peak]) peak = k;
        const mins = win.map(h => h.ml_wave_height_min).filter(v => v != null);
        const maxs = win.map(h => h.ml_wave_height_max).filter(v => v != null);
        const periods = win.map(h => h.peak_period).filter(v => v != null);
        out.push({
            startIdx: s, peakHour: win[peak], startHour: win[0], endBoundary,
            avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
            peakScore: scores[peak],
            waveMin: mins.length ? Math.min(...mins) : win[peak].ml_wave_height_min,
            waveMax: maxs.length ? Math.max(...maxs) : win[peak].ml_wave_height_max,
            displayPeriod: periods.length ? Math.max(...periods) : win[peak].peak_period,
        });
    }
    return out;
}
function getBestSurfWindow(dayHours, spot) {
    const c = collectBestWindowCandidates(dayHours, spot, 3);
    return c.reduce((best, x) => {
        if (!best) return x;
        if (x.avgScore > best.avgScore + 1e-9) return x;
        if (Math.abs(x.avgScore - best.avgScore) < 1e-9 && x.peakScore > best.peakScore + 1e-9) return x;
        return best;
    }, null);
}

/* ---------- better spot nearby (from index.json day summaries) ---------- */
function _indexDay(entry, dateStr) {
    const row = (entry.days || []).find(d => d[0] === dateStr);
    if (!row) return null;
    return { score: row[1] / 10, good: row[2], fair: row[3], poor: row[4], hour: row[5], wave: row[6] == null ? null : row[6] / 100, char: row[7] };
}
function findBetterNearby(currentId, dateStr) {
    const idx = S.index; if (!idx) return null;
    const me = idx.byId[currentId];
    if (!me || me.lat == null) return null;
    const myDay = _indexDay(me, dateStr);
    if (!myDay) return null;
    let pick = null, pickAdj = -Infinity;
    for (const e of idx.spots) {
        if (e.id === currentId || e.lat == null) continue;
        const d = haversineKm(me.lat, me.lon, e.lat, e.lon);
        if (d > _nearbyRadiusKm) continue;
        const ds = _indexDay(e, dateStr);
        if (!ds || ds.score <= myDay.score + MIN_SCORE_GAIN - 1) continue;
        const adj = ds.score - d * DISTANCE_PENALTY;
        if (adj > pickAdj) { pickAdj = adj; pick = { id: e.id, name: e.name, dist: d, good_h: ds.good, fair_h: ds.fair }; }
    }
    return pick;
}

/* ---------- 7-day carousel ---------- */
function _daySamples(tiers) {
    if (!tiers.length) return ['flat', 'flat', 'flat', 'flat'];
    const out = [];
    const step = Math.max(1, Math.floor(tiers.length / 4));
    for (let i = 0; i < tiers.length && out.length < 4; i += step) out.push(tiers[i]);
    while (out.length < 4) out.push(out[out.length - 1] || 'flat');
    return out;
}

/** Cards from the index only (shown while the spot file loads, or offline). */
function buildCoarseDayCards(entry) {
    const idx = S.index;
    const tz = entry.tz || 'UTC';
    const byDate = new Map();
    for (let i = 0; i < idx.n; i++) {
        const ms = indexHourMs(idx, i);
        if (ms < Date.now() - 3600000) continue;
        const date = zonedParts(ms, tz).date;
        if (!byDate.has(date)) byDate.set(date, []);
        if (entry.d && entry.d[i] === '1') byDate.get(date).push(RATING_CHAR_TIER[entry.r[i]] || 'flat');
    }
    const cards = [];
    for (const [date, tiers] of byDate) {
        const day = _indexDay(entry, date);
        const card = { date, samples: _daySamples(tiers), coarse: true };
        if (day && day.hour != null) {
            const key = RATING_CHAR_KEY[day.char] || 'Flat';
            card.bestColor = `var(--${RATING_CHAR_TIER[day.char] || 'flat'})`;
            card.bestText = (key === 'Good' || key === 'Fair') ? t('day.bestAt', { rating: ratingLabel(key), time: hourLabel(day.hour) }) : t(day.wave != null && day.wave < 0.3 ? 'day.flat' : 'day.poorAllDay');
            card.height = day.wave != null ? fmt(day.wave) : '--';
        } else {
            card.bestText = '';
            card.height = '--';
        }
        cards.push(card);
    }
    return cards;
}

function buildFullDayCards() {
    const spot = S.spotData.spot;
    const dailyByDate = new Map((S.spotData.daily || []).map(d => [d.date, d]));
    return S.daily.map(d => {
        const dayHours = S.hourly.filter(h => spotLocalDateStr(h._ms, spot) === d.date);
        const daylight = dayHours.filter(h => isDaylight(h, spot));
        const card = { date: d.date, samples: _daySamples((daylight.length ? daylight : dayHours).map(getRatingColor)) };
        const ml = dayHours.filter(h => h.ml_wave_height_max != null);
        const nonPoor = ml.reduce((n, h) => { const k = ratingKey(h); return (k === 'Good' || k === 'Fair') ? n + 1 : n; }, 0);
        let bestHour = null, displayHeight = null, displayPeriod = null, rangeStr = null, timeLabel = '';
        if (ml.length) {
            const win = getBestSurfWindow(dayHours, spot);
            if (win) {
                bestHour = win.peakHour;
                displayHeight = win.waveMax; displayPeriod = win.displayPeriod;
                rangeStr = fmtRange(win.waveMin, win.waveMax);
                const st = spotLocalParts(win.startHour._ms, spot).hour, en = spotLocalParts(win.endBoundary._ms, spot).hour;
                timeLabel = nonPoor >= 3 ? t('day.window', { a: hourLabel(st), b: hourLabel(en) }) : hourLabel(spotLocalParts(win.peakHour._ms, spot).hour);
            } else {
                const pool = daylight.filter(h => h.ml_wave_height_max != null);
                const search = pool.length ? pool : [ml[0]];
                bestHour = search.reduce((b, h) => getBestPeriodHourScore(h) > getBestPeriodHourScore(b) ? h : b, search[0]);
                displayHeight = bestHour.ml_wave_height_max; displayPeriod = bestHour.peak_period;
                rangeStr = fmtRange(bestHour.ml_wave_height_min, bestHour.ml_wave_height_max);
                timeLabel = hourLabel(spotLocalParts(bestHour._ms, spot).hour);
            }
            const key = ratingKey(bestHour);
            card.bestColor = `var(--${getRatingColor(bestHour)})`;
            card.bestText = (nonPoor > 0 && (key === 'Good' || key === 'Fair'))
                ? t('day.bestAt', { rating: ratingLabel(key), time: timeLabel })
                : t(displayHeight < 0.3 ? 'day.flat' : 'day.poorAllDay');
        } else {
            const dd = dailyByDate.get(d.date) || {};
            displayHeight = dd.best_wave_height || dd.max_wave_height;
            displayPeriod = dd.best_peak_period || dd.mean_peak_period;
            card.bestText = t('day.noData');
        }
        card.height = rangeStr || fmt(displayHeight);
        card.sets = bestHour ? bestHour.ml_wave_height_sets : null;
        card.period = displayPeriod;
        card.waveDir = bestHour ? bestHour.wave_direction : null;
        card.bestTime = bestHour ? bestHour.time : null;
        return card;
    });
}

function renderCarousel(cards) {
    const container = $('daily-carousel');
    container.innerHTML = '';
    const spot = currentSpotMeta();
    const today = todayStrFor(spot);
    const activeDate = S.activeDate || (cards.some(c => c.date === today) ? today : (cards[0] && cards[0].date));
    for (const c of cards) {
        const isToday = c.date === today;
        const card = document.createElement('div');
        card.className = 'daily-card' + (c.coarse ? ' is-coarse' : '') + (c.date === activeDate ? ' active' : '');
        card.setAttribute('role', 'listitem');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'daily-card-main';
        btn.setAttribute('aria-pressed', String(c.date === activeDate));
        const setsHtml = c.sets != null
            ? `<span class="daily-set-badge">${escapeHtml(t('hero.setsUpTo', { v: fmt(c.sets) }))}</span>`
            : (c.coarse ? '' : '<span class="daily-set-spacer"></span>');
        const tpHtml = c.coarse ? '' : `<span class="daily-tp">${c.waveDir != null ? arrowSvg(travelBearing(c.waveDir), 12, t('dir.travelsToward', { dir: compassLabel(travelBearing(c.waveDir)) })) : ''} Tp ${escapeHtml(fmt(c.period, 0))} s</span>`;
        btn.innerHTML = `
            <span class="daily-day">${escapeHtml(isToday ? t('day.today') : weekdayShort(c.date))}<span class="daily-date">${escapeHtml(dayMonth(c.date))}</span></span>
            <span class="daily-best" style="color:${c.bestColor || 'var(--text-muted)'}">${escapeHtml(c.bestText || '')}</span>
            <span class="daily-height-container"><span class="daily-height">${escapeHtml(c.height)}<span class="daily-unit">m</span></span>${setsHtml}</span>
            ${tpHtml}`;
        card.appendChild(btn);

        const better = findBetterNearby(S.current, c.date);
        if (better) {
            const bits = [];
            if (better.good_h) bits.push(t('nearby.goodH', { n: better.good_h }));
            if (better.fair_h) bits.push(t('nearby.fairH', { n: better.fair_h }));
            const hint = document.createElement('button');
            hint.type = 'button';
            hint.className = 'better-nearby';
            hint.innerHTML = `<span class="bn-name">→ ${escapeHtml(better.name)}</span><span class="bn-meta">${escapeHtml((bits.length ? bits.join(' + ') : t('nearby.mostlyPoor')) + ' · ' + t('nearby.km', { n: Math.round(better.dist) }))}</span>`;
            hint.setAttribute('aria-label', t('nearby.aria', { name: better.name, n: Math.round(better.dist) }));
            hint.addEventListener('click', () => { openSpot(better.id); window.scrollTo({ top: 0, behavior: 'smooth' }); });
            card.appendChild(hint);
        } else if (S.index) {
            const none = document.createElement('div');
            none.className = 'no-better';
            none.textContent = t('nearby.none');
            card.appendChild(none);
        }
        const strip = document.createElement('div');
        strip.className = 'daily-rating-strip';
        strip.setAttribute('aria-hidden', 'true');
        strip.innerHTML = c.samples.map(r => `<div class="bg-${r}"></div>`).join('');
        card.appendChild(strip);

        if (!c.coarse) btn.addEventListener('click', () => selectDay(c, card));
        else btn.disabled = true;
        container.appendChild(card);
    }
    if (activeDate) $('current-day-label').textContent = localDayLabel(activeDate, spot);
}

function selectDay(c, cardEl) {
    const spot = S.spotData.spot;
    S.activeDate = c.date;
    document.querySelectorAll('#daily-carousel .daily-card').forEach(el => {
        el.classList.toggle('active', el === cardEl);
        const b = el.querySelector('.daily-card-main');
        if (b) b.setAttribute('aria-pressed', String(el === cardEl));
    });
    $('current-day-label').textContent = localDayLabel(c.date, spot);
    let morning = S.hourly.findIndex(h => spotLocalDateStr(h._ms, spot) === c.date && isDaylight(h, spot));
    if (morning < 0) morning = S.hourly.findIndex(h => spotLocalDateStr(h._ms, spot) === c.date);
    const scroller = $('unified-scroll');
    if (morning >= 0) scroller.scrollTo({ left: getHourlyScrollLeft(morning, scroller, true), behavior: 'smooth' });
    const target = c.bestTime ? S.hourly.findIndex(h => h.time === c.bestTime) : morning;
    if (target >= 0) selectHour(target, { scroll: false });
}

/* ---------- hourly track ---------- */
function renderTrackSkeleton() {
    $('unified-skeleton').hidden = false;
    $('unified-track').hidden = true;
    $('hourly-focus').innerHTML = `<div class="hourly-focus-head"><div><div class="hourly-focus-kicker">${escapeHtml(t('focus.kicker'))}</div><div class="hourly-focus-time"><span class="skeleton skeleton-line" style="width:12rem"></span></div></div></div>`;
    const panel = $('detail-panel');
    panel.classList.remove('open');
    panel.innerHTML = '';
}

function renderUnifiedTrack() {
    const spot = S.spotData.spot;
    const timeRow = $('time-row'), stripRow = $('rating-strip'), waveRow = $('wave-bars'), swellRow = $('swell-dir-row'), windRow = $('wind-row');
    $('unified-skeleton').hidden = true;
    $('unified-track').hidden = false;
    const label = key => `<div class="row-label">${t(key)}</div>`;
    const timeHtml = ['<div class="row-label"></div>'], stripHtml = [label('track.rating')];
    waveRow.innerHTML = label('track.surf');
    swellRow.innerHTML = label('track.ocean');
    windRow.innerHTML = label('track.wind');

    const maxWave = Math.max(...S.hourly.map(h => h.ml_wave_height_sets || h.ml_wave_height_max || 0), 0.5);
    const BAR_MAX = 100;
    const now = spotLocalParts(Date.now(), spot);
    let prevDay = '';
    const waveFrag = document.createDocumentFragment(), swellFrag = document.createDocumentFragment(), windFrag = document.createDocumentFragment();

    S.hourly.forEach((h, i) => {
        const tp = spotLocalParts(h._ms, spot);
        const night = !isDaylight(h, spot);
        const nightClass = night ? ' slot-night' : '';
        const tier = getRatingColor(h);
        const rLabel = ratingLabel(ratingKey(h));
        const isDayStart = tp.date !== prevDay;
        prevDay = tp.date;
        const isNow = tp.date === now.date && tp.hour === now.hour;
        const dayLabel = isDayStart ? `<span class="day-label">${escapeHtml(tp.date === now.date ? t('day.today') : `${weekdayShort(tp.date)} ${tp.day}`)}</span>` : '';
        timeHtml.push(`<div class="time-slot${nightClass}${isDayStart ? ' day-start' : ''}${isNow ? ' is-now' : ''}">${dayLabel}${escapeHtml(hourLabel(tp.hour))}</div>`);
        stripHtml.push(`<div class="rating-segment bg-${tier}${nightClass}">${escapeHtml(rLabel)}</div>`);

        const mlMax = h.ml_wave_height_max || 0;
        const mlSets = h.ml_wave_height_sets != null ? h.ml_wave_height_sets : mlMax;
        const barH = Math.max(3, (mlMax / maxWave) * BAR_MAX);
        const setH = Math.max(barH, (mlSets / maxWave) * BAR_MAX);
        const innerPct = setH > 0 ? Math.min(100, (barH / setH) * 100) : 100;
        const waveLabel = h.ml_wave_height_max != null ? fmtRange(h.ml_wave_height_min, h.ml_wave_height_max) : '--';
        const surf = h.ml_surface ? String(h.ml_surface).toLowerCase() : '';
        const slot = document.createElement('button');
        slot.type = 'button';
        slot.className = 'wave-slot' + nightClass;
        slot.dataset.index = String(i);
        slot.setAttribute('aria-label', t('track.slotAria', { time: hourLabel(tp.hour), day: localDayLabel(tp.date, spot), waves: waveLabel, sets: fmt(mlSets), rating: rLabel }));
        slot.innerHTML = `<span class="wave-label">${escapeHtml(waveLabel)}</span>
            <span class="wave-bar-wrapper" style="height:${setH}px"><span class="set-bar-ext" style="height:100%"></span><span class="wave-bar" style="height:${innerPct}%;display:block"></span></span>
            ${surf ? `<span class="surf-tag surf-tag-${surf}">${escapeHtml(surfaceLabel(h.ml_surface))}</span>` : ''}`;
        slot.addEventListener('click', () => {
            selectHour(i, { scroll: false });
            if (window.innerWidth < 600) $('hourly-focus').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
        waveFrag.appendChild(slot);

        const sd = document.createElement('div');
        sd.className = 'swell-dir-slot' + nightClass;
        if (h.wave_direction != null) {
            const from = compassLabel(h.wave_direction), to = compassLabel(travelBearing(h.wave_direction));
            sd.title = t('track.oceanTitle', { hs: fmt(h.wave_height_model), tp: fmt(h.peak_period, 0), from, to });
            sd.innerHTML = `<span class="swell-hs">${escapeHtml(fmt(h.wave_height_model))}<small> m · ${escapeHtml(fmt(h.peak_period, 0))} s</small></span>
                <span class="swell-from"><span class="hourly-arrow" style="--direction:${travelBearing(h.wave_direction)}deg" aria-hidden="true">↑</span>${escapeHtml(from)}</span>`;
        }
        swellFrag.appendChild(sd);

        const ws = document.createElement('div');
        ws.className = 'wind-slot' + nightClass;
        if (h.wind_speed_kmh != null) {
            const speed = h.wind_speed_kmh || 0;
            const gust = h.wind_gusts_kmh != null ? h.wind_gusts_kmh : speed;
            const effect = getWindEffect(h, spot);
            const color = windEffectColor(effect.key);
            const hasDir = h.wind_direction != null;
            const tip = t('track.windTitle', { from: hasDir ? compassLabel(h.wind_direction) : '?', to: hasDir ? compassLabel(travelBearing(h.wind_direction)) : '?', speed: fmt(speed, 0), gust: fmt(gust, 0), effect: effect.label });
            ws.title = tip;
            ws.innerHTML = `<span class="wind-data-pill"><span class="wind-speed-label">${Math.round(speed)}</span><span class="wind-gust-sublabel">${escapeHtml(t('wind.gustShort', { v: Math.round(gust) }))}</span></span>
                <span class="wind-arrow-wrap" style="border-color:${color}">${hasDir ? `<span class="hourly-arrow wind" style="--direction:${travelBearing(h.wind_direction)}deg;color:${color};margin:0" aria-hidden="true">↑</span>` : ''}</span>
                <span class="wind-effect-label" style="color:${color}">${escapeHtml(effect.key ? t('windShort.' + effect.key) : '')}</span>`;
        }
        windFrag.appendChild(ws);
    });
    timeRow.innerHTML = timeHtml.join('');
    stripRow.innerHTML = stripHtml.join('');
    waveRow.appendChild(waveFrag);
    swellRow.appendChild(swellFrag);
    windRow.appendChild(windFrag);

    const closest = findClosestHour(S.hourly).i;
    const scroller = $('unified-scroll');
    scroller.scrollLeft = getHourlyScrollLeft(closest, scroller);
    const panel = $('detail-panel');
    panel.classList.remove('open');
    panel.innerHTML = '';
    selectHour(closest, { scroll: false, keepDetail: false });

    $('scroll-left').onclick = () => scroller.scrollBy({ left: -getHourlySlotWidth() * 5, behavior: 'smooth' });
    $('scroll-right').onclick = () => scroller.scrollBy({ left: getHourlySlotWidth() * 5, behavior: 'smooth' });
}

function selectHour(idx, { scroll = true } = {}) {
    const h = S.hourly[idx];
    if (!h) return;
    S.selectedIdx = idx;
    document.querySelectorAll('#wave-bars .wave-slot.active').forEach(s => { s.classList.remove('active'); s.removeAttribute('aria-current'); });
    const slot = getHourlyWaveSlot(idx);
    if (slot) { slot.classList.add('active'); slot.setAttribute('aria-current', 'true'); }
    const spot = S.spotData.spot;
    $('current-day-label').textContent = localDayLabel(spotLocalDateStr(h._ms, spot), spot);
    if (scroll) {
        const scroller = $('unified-scroll');
        scroller.scrollTo({ left: getHourlyScrollLeft(idx, scroller), behavior: 'smooth' });
    }
    if ($('detail-panel').classList.contains('open')) showDetailPanel(h);
    else renderHourlyFocus(h);
}

function renderHistoricalLine(h) {
    if (!h || !h.ml_hist_rating) return '';
    const parts = [];
    if (h.ml_hist_wave_max != null) parts.push(`${fmtRange(h.ml_hist_wave_min, h.ml_hist_wave_max)} m`);
    if (h.ml_hist_wave_sets != null) parts.push(t('detail.setsV', { v: fmt(h.ml_hist_wave_sets) }));
    const waves = parts.length ? ' · ' + escapeHtml(parts.join(' · ')) : '';
    const n = h.ml_hist_n ? ` <span style="opacity:0.75">(${escapeHtml(t('detail.pastSessions', { n: h.ml_hist_n }))})</span>` : '';
    return `<div class="hist-line">${escapeHtml(t('detail.histSimilar'))} <strong>${escapeHtml(ratingLabel(ratingKey({ ml_conseil: h.ml_hist_rating })))}</strong>${waves}${n}</div>`;
}

function renderHourlyFocus(h) {
    const focus = $('hourly-focus');
    const sd = S.spotData;
    if (!focus || !sd || !h) return;
    const spot = sd.spot;
    const tp = spotLocalParts(h._ms, spot);
    const timeStr = `${localDayLabel(tp.date, spot)} · ${hhmm(tp)}`;
    const tier = getRatingColor(h);
    const wdir = h.wave_direction, wn = h.wind_direction;
    const waveArrow = wdir != null ? `<span class="hourly-arrow" style="--direction:${travelBearing(wdir)}deg" aria-hidden="true">↑</span>` : '';
    const windArrow = wn != null ? `<span class="hourly-arrow wind" style="--direction:${travelBearing(wn)}deg" aria-hidden="true">↑</span>` : '';
    const open = $('detail-panel').classList.contains('open');
    const surface = h.ml_surface ? surfaceLabel(h.ml_surface) : getSurfaceTexture(h, spot);
    focus.innerHTML = `
        <div class="hourly-focus-head">
            <div>
                <div class="hourly-focus-kicker">${escapeHtml(t('focus.kicker'))}</div>
                <div class="hourly-focus-time">${escapeHtml(timeStr)}</div>
            </div>
            <div class="hourly-focus-actions">
                <span class="rating-badge bg-${tier}">${escapeHtml(ratingLabel(ratingKey(h)))}</span>
                <button class="hourly-breakdown-btn" type="button" aria-expanded="${open}" aria-controls="detail-panel">${escapeHtml(t(open ? 'focus.hide' : 'focus.full'))}</button>
            </div>
        </div>
        <div class="hourly-focus-grid">
            <div class="hourly-focus-group">
                <div class="hourly-focus-label">${escapeHtml(t('focus.surf'))}</div>
                <div class="hourly-focus-value">${h.ml_wave_height_max != null ? escapeHtml(fmtRange(h.ml_wave_height_min, h.ml_wave_height_max)) + ' m' : '--'}</div>
                <div class="hourly-focus-meta">${escapeHtml(t('detail.setsV', { v: fmt(h.ml_wave_height_sets) }))} · ${escapeHtml(surface)}</div>
            </div>
            <div class="hourly-focus-group">
                <div class="hourly-focus-label">${escapeHtml(t('focus.ocean'))}</div>
                <div class="hourly-focus-value">Hs ${h.wave_height_model != null ? escapeHtml(fmt(h.wave_height_model)) + ' m' : '--'} · Tp ${h.peak_period != null ? escapeHtml(fmt(h.peak_period, 0)) + ' s' : '--'}</div>
                <div class="hourly-focus-meta">${waveArrow}${wdir != null ? escapeHtml(t('dir.fromTo', { from: compassLabel(wdir), deg: Math.round(wdir), to: compassLabel(travelBearing(wdir)) })) : '--'}</div>
            </div>
            <div class="hourly-focus-group">
                <div class="hourly-focus-label">${escapeHtml(t('focus.wind'))}</div>
                <div class="hourly-focus-value">${h.wind_speed_kmh != null ? escapeHtml(fmt(h.wind_speed_kmh, 0)) + ' km/h' : '--'}</div>
                <div class="hourly-focus-meta">${escapeHtml(t('wind.gustsKmh', { v: fmt(h.wind_gusts_kmh, 0) }))} · ${windArrow}${wn != null ? escapeHtml(t('dir.fromTo', { from: compassLabel(wn), deg: Math.round(wn), to: compassLabel(travelBearing(wn)) })) : '--'} · ${escapeHtml(getWindEffect(h, spot).label)}</div>
            </div>
            <div class="hourly-focus-group">
                <div class="hourly-focus-label">${escapeHtml(t('focus.tide'))}</div>
                <div class="hourly-focus-value">${h.tide_height != null ? escapeHtml(fmt(h.tide_height)) + ' m' : '--'}</div>
                <div class="hourly-focus-meta">${escapeHtml(tideTrendLabel(h.tide_trend) || t('tide.trendUnknown'))}${h.tide_issue ? ' · ' + escapeHtml(tideIssueLabel(h.tide_issue)) : ''}</div>
            </div>
        </div>`;
    focus.querySelector('.hourly-breakdown-btn').addEventListener('click', () => {
        const panel = $('detail-panel');
        if (panel.classList.contains('open')) {
            panel.classList.remove('open');
            renderHourlyFocus(h);
        } else {
            showDetailPanel(h);
            setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
        }
    });
}

function showDetailPanel(h) {
    const panel = $('detail-panel');
    const spot = S.spotData.spot;
    panel.classList.add('open');
    const tp = spotLocalParts(h._ms, spot);
    const key = ratingKey(h), tier = getRatingColor(h);
    const proba = h.ml_conseil_proba || {};
    const topProba = h.ml_conseil_conf || proba[key] || 0;
    const conf = getConfidenceMeta(topProba || null);
    const rangeOnly = h.ml_wave_height_max != null ? `${fmtRange(h.ml_wave_height_min, h.ml_wave_height_max)} m` : '--';
    const wavesHtml = escapeHtml(rangeOnly) + (h.ml_wave_height_sets != null ? ` <span style="color:var(--accent);font-weight:700">&uarr;${escapeHtml(fmt(h.ml_wave_height_sets))} m</span>` : '');
    const comp = (height, period, direction) => {
        if (height == null) return '--';
        const parts = [`${fmt(height)} m`];
        if (period != null) parts.push(`${fmt(period, 0)} s`);
        const dm = directionMarkup(direction);
        return escapeHtml(parts.join(' · ')) + (dm !== '--' ? ' · ' + dm : '');
    };
    const p1 = h.swell_height_model != null ? h.swell_height_model : h.swell_height;
    const p2 = h.swell2_height_model != null ? h.swell2_height_model : h.swell2_height;
    const ww = h.wind_wave_height_model != null ? h.wind_wave_height_model : h.wind_wave_height;
    const row = (labelKey, val, tip) => `<div class="d-row"><span class="d-label${tip ? ' tip-target' : ''}"${tip ? ` title="${escapeHtml(t(tip))}"` : ''}>${escapeHtml(t(labelKey))}</span><span class="d-val">${val}</span></div>`;
    const probaRow = Object.keys(proba).length
        ? `<div class="d-row sep"><span class="d-label">${escapeHtml(t('detail.proba'))}</span><span class="d-val">${escapeHtml(Object.entries(proba).map(([k, v]) => `${ratingLabel(k === 'Epic' ? 'Good' : k)} ${fmtPct(v)}`).join(' · '))}</span></div>`
        : '';
    panel.innerHTML = `
        <div class="detail-header">
            <div class="detail-header-left">
                <span class="detail-time">${escapeHtml(`${localDayLabel(tp.date, spot)} ${hhmm(tp)}`)}</span>
                <span class="rating-badge bg-${tier}">${escapeHtml(ratingLabel(key))}</span>
                ${h.ml_conseil && conf.key ? `<span class="small-badge" style="color:${conf.color}">${escapeHtml(t('conf.' + conf.key))}</span>` : ''}
                ${tideScoreBadge(h)}
            </div>
            <button class="detail-close" type="button" id="detail-close-btn" aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>
        <div class="detail-surf-banner">
            <div>
                <div class="surf-label tip-target" title="${escapeHtml(t('tip.face'))}">${escapeHtml(t('detail.faceTitle'))}</div>
                <div class="surf-value">${wavesHtml}</div>
            </div>
            <div class="surf-offshore tip-target" title="${escapeHtml(t('tip.offshoreHs'))}">${escapeHtml(t('detail.offshoreHs', { v: h.wave_height_model != null ? fmt(h.wave_height_model) + ' m' : '--' }))}</div>
        </div>
        ${renderHistoricalLine(h)}
        <div class="detail-grid">
            <div class="detail-block">
                <div class="detail-block-title">${escapeHtml(t('detail.oceanTitle'))}</div>
                ${row('detail.totalSea', comp(h.wave_height_model, h.peak_period, h.wave_direction), 'tip.totalSea')}
                ${row('detail.primary', comp(p1, h.swell_period, h.swell_direction))}
                ${p2 != null && p2 > 0.1 ? row('detail.secondary', comp(p2, h.swell2_period, h.swell2_direction)) : ''}
                ${ww != null && ww > 0.1 ? row('detail.windWave', comp(ww, h.wind_wave_period, h.wind_wave_direction)) : ''}
                <div class="d-row sep"><span class="d-label">${escapeHtml(t('focus.tide'))}</span><span class="d-val">${h.tide_height != null ? escapeHtml(fmt(h.tide_height)) + ' m' : '--'}${h.tide_trend ? ' · ' + escapeHtml(tideTrendLabel(h.tide_trend)) : ''}</span></div>
            </div>
            <div class="detail-block">
                <div class="detail-block-title">${escapeHtml(t('focus.wind'))}</div>
                ${row('detail.speed', h.wind_speed_kmh != null ? escapeHtml(fmt(h.wind_speed_kmh, 0)) + ' km/h' : '--')}
                ${row('detail.gusts', h.wind_gusts_kmh != null ? escapeHtml(fmt(h.wind_gusts_kmh, 0)) + ' km/h' : '--')}
                ${row('detail.direction', directionMarkup(h.wind_direction))}
                ${row('detail.effect', escapeHtml(getWindEffect(h, spot).label))}
            </div>
            <div class="detail-block">
                <div class="detail-block-title">${escapeHtml(t('detail.aiTitle'))}</div>
                ${row('detail.rating', `<span class="rating-badge bg-${tier}">${escapeHtml(ratingLabel(key))}</span>`)}
                ${row('detail.surface', escapeHtml(h.ml_surface ? surfaceLabel(h.ml_surface) : getSurfaceTexture(h, spot)))}
                ${key !== 'Poor' ? row('detail.level', escapeHtml(skillLabel(h.ml_skill))) : ''}
                ${probaRow}
            </div>
        </div>`;
    $('detail-close-btn').addEventListener('click', () => {
        panel.classList.remove('open');
        renderHourlyFocus(h);
    });
    renderHourlyFocus(h);
}

/* ---------- tide canvas ---------- */
function renderTideCanvas() {
    const canvas = $('tide-canvas');
    if (!canvas || !S.hourly.length || S.tides.length < 2) {
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        return;
    }
    const slotW = getHourlySlotWidth();
    const dpr = window.devicePixelRatio || 1;
    const W = S.hourly.length * slotW;
    const H = canvas.parentElement.clientHeight || 116;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = { top: 30, bottom: 30 };
    const getX = i => i * slotW + slotW / 2;
    const tMin = S.hourly[0]._ms;
    const tMax = S.hourly[S.hourly.length - 1]._ms + 3600000;
    const tides = S.tides.filter(td => td.ms >= tMin - 12 * 3600000 && td.ms <= tMax + 12 * 3600000);
    if (tides.length < 2) return;
    let minTH = Infinity, maxTH = -Infinity;
    for (const td of tides) { minTH = Math.min(minTH, td.height); maxTH = Math.max(maxTH, td.height); }
    const range = maxTH - minTH || 1;
    const yScale = v => pad.top + (1 - (v - minTH + 0.2) / (range + 0.4)) * (H - pad.top - pad.bottom);
    const interp = ms => { const s = getTideSnapshotAt(ms, tides); return s ? s.height : (minTH + maxTH) / 2; };
    const span = tMax - tMin - 3600000;
    const n = S.hourly.length;
    const steps = n * 6;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        pts.push([getX(f * (n - 1)), yScale(interp(tMin + f * span))]);
    }
    ctx.beginPath();
    ctx.moveTo(0, H);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(W, H);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(26, 192, 198, 0.35)');
    grad.addColorStop(1, 'rgba(26, 192, 198, 0)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = '#1ac0c6';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const spot = S.spotData.spot;
    const font = getComputedStyle(document.body).fontFamily;
    let lastX = -999;
    for (const td of tides) {
        if (td.ms < tMin || td.ms > tMax) continue;
        const x = getX(((td.ms - tMin) / span) * (n - 1));
        const y = yScale(td.height);
        if (Math.abs(x - lastX) < 40) continue;
        lastX = x;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = td.type === 'high' ? '#1ac0c6' : '#0ea5e9';
        ctx.fill();
        ctx.strokeStyle = '#0d1e36';
        ctx.lineWidth = 1;
        ctx.stroke();
        const high = td.type === 'high';
        const labelY = high ? y - 8 : y + 16;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f8fafc';
        ctx.font = `700 12px ${font}`;
        ctx.fillText(`${fmt(td.height)} m`, x, labelY);
        ctx.fillStyle = '#a5b6ca';
        ctx.font = `500 12px ${font}`;
        ctx.fillText(hhmm(spotLocalParts(td.ms, spot)), x, labelY + (high ? -13 : 13));
    }
    const now = Date.now();
    if (now >= tMin && now <= tMax) {
        const snap = getTideSnapshotAt(now, tides);
        const nx = getX(((now - tMin) / span) * (n - 1));
        const ny = yScale(interp(now));
        ctx.strokeStyle = 'rgba(255,255,255,0.58)';
        ctx.lineWidth = 1.25;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(nx, pad.top - 8); ctx.lineTo(nx, H); ctx.stroke();
        ctx.setLineDash([]);
        const label = t('tide.now') + (snap && snap.label ? ' · ' + snap.label : '');
        ctx.font = `700 12px ${font}`;
        const right = nx > W - 140;
        ctx.textAlign = right ? 'right' : 'left';
        ctx.fillStyle = '#f8fafc';
        ctx.fillText(label.toUpperCase(), nx + (right ? -6 : 6), 14);
        ctx.shadowColor = '#1ac0c6'; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(nx, ny, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        ctx.shadowBlur = 0; ctx.strokeStyle = '#1ac0c6'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    canvas.setAttribute('aria-label', t('tide.canvasAria', { list: tides.filter(td => td.ms >= tMin && td.ms <= tMax).slice(0, 6).map(td => `${t(td.type === 'high' ? 'tide.high' : 'tide.low')} ${hhmm(spotLocalParts(td.ms, spot))} ${fmt(td.height)} m`).join(', ') }));
}

/* ---------- orchestration ---------- */
function renderSpotLoading() {
    const e = currentEntry();
    renderSpotHeader();
    renderHeroLoading();
    if (e && S.index) renderCarousel(buildCoarseDayCards(e));
    renderTrackSkeleton();
    $('spot-error').hidden = true;
}

function renderSpotFull() {
    const sd = S.spotData;
    S.hourly = getVisibleForecastHours(sd);
    S.tides = sd.tides || [];
    const localDays = Array.from(new Set(S.hourly.map(h => spotLocalDateStr(h._ms, sd.spot)))).sort();
    S.daily = localDays.map(date => ({ date }));
    S.activeDate = null;
    renderSpotHeader();
    renderHero();
    renderCarousel(buildFullDayCards());
    renderUnifiedTrack();
    requestAnimationFrame(renderTideCanvas);
    Webcam.render(sd.spot.webcam, sd.spot.name);
}

/** Re-render the current view in place (language change, radius change). */
function rerenderSpot() {
    if (S.spotData) {
        const sel = S.selectedIdx;
        const open = $('detail-panel').classList.contains('open');
        const scroller = $('unified-scroll');
        const left = scroller.scrollLeft;
        renderSpotHeader();
        renderHero();
        const active = S.activeDate;
        renderCarousel(buildFullDayCards());
        renderUnifiedTrack();
        S.activeDate = active;
        scroller.scrollLeft = left;
        if (sel >= 0 && S.hourly[sel]) {
            selectHour(sel, { scroll: false });
            if (open) showDetailPanel(S.hourly[sel]);
        }
        requestAnimationFrame(renderTideCanvas);
        Webcam.relabel();
    } else if (currentEntry()) {
        renderSpotLoading();
    }
}

let _resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(renderTideCanvas, 200);
});
