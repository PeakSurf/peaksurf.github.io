/* PeakSurf /next/ — application shell: boot, navigation, favourites,
   freshness / offline banners, tabs, lazy modules, install prompt, SW. */
'use strict';

const FAV_KEY = 'alaia_fav_spots';          // shared with the classic pages
const FAV_INIT_KEY = 'alaia_fav_v2';
const IOS_HINT_KEY = 'peaksurf_ios_hint_dismissed';
const DEFAULT_FAVS = [
    'hossegor-centrale', 'la-centrale-capbreton', 'biarritz-grande-plage', 'hendaye',
    'lacanau', 'supertubos', 'arrifana',
    'les-cavaliers-anglet', 'les-estagnots-seignosse', 'biscarrosse',
];

let _searchQuery = '';
let _spotToken = 0;
let _view = 'forecast';
let _pendingGen = null;

/* ---------- lazy script / css loading ---------- */
const _loaded = new Map();
function loadScript(src) {
    if (_loaded.has(src)) return _loaded.get(src);
    const p = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = false;
        s.onload = () => resolve();
        s.onerror = () => { _loaded.delete(src); reject(new Error('Failed to load ' + src)); };
        document.head.appendChild(s);
    });
    _loaded.set(src, p);
    return p;
}
function loadCss(href) {
    if (_loaded.has(href)) return _loaded.get(href);
    const p = new Promise((resolve, reject) => {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = href;
        l.onload = () => resolve();
        l.onerror = () => { _loaded.delete(href); reject(new Error('Failed to load ' + href)); };
        document.head.appendChild(l);
    });
    _loaded.set(href, p);
    return p;
}
const ASSET_V = (document.querySelector('meta[name="ps-asset-version"]') || {}).content || '';
function assetUrl(path) { return ASSET_V ? `${path}?v=${ASSET_V}` : path; }
function loadMaps() {
    return Promise.all([loadCss(assetUrl('vendor/leaflet/leaflet.css')), loadScript(assetUrl('vendor/leaflet/leaflet.js'))])
        .then(() => loadScript(assetUrl('maps.js')));
}

/* ---------- favourites ---------- */
function getFavorites() {
    try { const v = JSON.parse(storeGet(FAV_KEY, '[]')); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function setFavorites(favs) { storeSet(FAV_KEY, JSON.stringify(favs)); }
function toggleFavorite(id) {
    let favs = getFavorites();
    favs = favs.includes(id) ? favs.filter(f => f !== id) : favs.concat(id);
    setFavorites(favs);
    renderSpotNav();
    updateFavToggle();
}
function updateFavToggle() {
    const btn = $('fav-toggle');
    if (!btn || !S.current) return;
    const isFav = getFavorites().includes(S.current);
    btn.innerHTML = isFav ? '&#9733;' : '&#9734;';
    btn.classList.toggle('is-fav', isFav);
    btn.setAttribute('aria-pressed', String(isFav));
    const label = t(isFav ? 'fav.remove' : 'fav.add');
    btn.title = label;
    btn.setAttribute('aria-label', label);
}

/* ---------- spot navigation ---------- */
function _normalise(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function renderSpotNav() {
    const nav = $('spot-nav');
    if (!S.index) return;
    const idx = S.index;
    const favs = getFavorites().filter(id => idx.byId[id]);
    const q = _normalise(_searchQuery.trim());
    const ordered = [...favs, ...idx.spot_order.filter(id => !favs.includes(id))];
    let show;
    if (q) {
        show = ordered.filter(id => {
            const e = idx.byId[id];
            return e && (_normalise(e.name).includes(q) || id.includes(q) || _normalise(e.region).includes(q));
        });
    } else {
        show = favs.length ? [...new Set([...favs, S.current].filter(Boolean))] : ordered.slice(0, 8);
    }
    nav.innerHTML = '';
    for (const id of show) {
        const e = idx.byId[id];
        if (!e) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'spot-btn' + (id === S.current ? ' active' : '') + (favs.includes(id) ? ' fav' : '');
        if (id === S.current) btn.setAttribute('aria-current', 'true');
        const nowTier = _nowTier(e);
        btn.innerHTML = `<span class="now-dot bg-${nowTier}" aria-hidden="true"></span>${escapeHtml(e.name)}${q ? `<span class="spot-btn-region">${escapeHtml(e.region || '')}</span>` : ''}`;
        btn.addEventListener('click', () => {
            const input = $('spot-search');
            if (input) { input.value = ''; _searchQuery = ''; input.blur(); }
            if (id !== S.current) openSpot(id);
            else renderSpotNav();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        nav.appendChild(btn);
    }
    if (q && !show.length) nav.innerHTML = `<span class="spot-nav-empty">${escapeHtml(t('nav.noResults'))}</span>`;
    $('spot-search-status').textContent = q ? t('nav.results', { n: show.length }) : '';
}
function _nowTier(entry) {
    const idx = S.index;
    const i = Math.round((Date.now() / 1000 - idx.t0) / idx.step);
    const c = entry.r ? entry.r[Math.max(0, Math.min(entry.r.length - 1, i))] : '-';
    return RATING_CHAR_TIER[c] || 'flat';
}

/* ---------- open a spot ---------- */
function setUrlParam(key, value) {
    try {
        const url = new URL(window.location.href);
        if (value == null) url.searchParams.delete(key); else url.searchParams.set(key, value);
        window.history.replaceState(null, '', url);
    } catch (e) { /* file:// or sandboxed */ }
}

async function openSpot(id, { focusTime = null } = {}) {
    if (!S.index || !S.index.byId[id]) return;
    const token = ++_spotToken;
    S.current = id;
    S.spotData = null;
    S.selectedIdx = -1;
    setUrlParam('spot', id);
    renderSpotNav();
    renderSpotLoading();
    if (window.Maps) Maps.onSpotChanged();
    if (window.Climato) Climato.onSpotChanged();
    try {
        const { spotData, offline } = await loadSpot(id, S.gen);
        if (token !== _spotToken) return;
        S.spotData = spotData;
        if (offline) setOffline(true);
        renderSpotFull();
        if (focusTime) {
            const i = S.hourly.findIndex(h => h.time === focusTime);
            if (i >= 0) selectHour(i);
        }
        if (window.Maps) Maps.onSpotChanged();
    } catch (err) {
        if (token !== _spotToken) return;
        console.error('Spot load failed', err);
        showSpotError(err, () => openSpot(id, { focusTime }));
    }
}

function _errorMessage(err) {
    if (!navigator.onLine || (err && err.kind === 'network')) return t('err.network');
    if (err && err.kind === 'notfound') return t('err.notFound');
    if (err && err.kind === 'schema') return t('err.schema');
    return t('err.generic');
}
function showSpotError(err, retry) {
    const box = $('spot-error');
    box.hidden = false;
    box.querySelector('p').innerHTML = `<strong>${escapeHtml(t('err.spotTitle'))}</strong> ${escapeHtml(_errorMessage(err))}`;
    const btn = box.querySelector('button');
    btn.onclick = () => { box.hidden = true; retry(); };
    $('conditions-summary').classList.remove('is-loading');
    ['hero-wave-detail', 'hero-ai-detail', 'hero-wind-detail', 'hero-swell-detail', 'hero-tide-trend', 'hero-sst-suit'].forEach(k => { $(k).textContent = ''; });
    $('unified-skeleton').hidden = true;
    $('hourly-focus').innerHTML = '';
}
function showAppError(err, retry) {
    const box = $('app-error');
    box.hidden = false;
    box.querySelector('p').innerHTML = `<strong>${escapeHtml(t('err.appTitle'))}</strong> ${escapeHtml(_errorMessage(err))}`;
    box.querySelector('button').onclick = () => { box.hidden = true; retry(); };
}

/* ---------- freshness / stale / offline ---------- */
function _genMs() {
    const g = (S.status && S.status.generated_at) || (S.index && S.index.generated_at);
    const ms = g ? Date.parse(g) : NaN;
    return Number.isFinite(ms) ? ms : null;
}
function renderFreshness() {
    const el = $('update-time');
    const banner = $('stale-banner');
    const ms = _genMs();
    if (ms == null) { el.textContent = ''; banner.hidden = true; return; }
    const when = fmtInstant(ms, undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const age = Date.now() - ms;
    el.textContent = t('fresh.updated', { when, ago: fmtRelativeAge(age) });
    el.title = new Date(ms).toISOString();
    const stale = age > CFG.staleAfterHours * 3600000;
    el.classList.toggle('is-stale', stale || S.offline);
    const inner = banner.querySelector('.status-banner-inner');
    if (S.offline) {
        banner.hidden = false;
        inner.className = 'status-banner-inner is-offline';
        inner.querySelector('.status-banner-text').textContent = t('banner.offline', { when });
    } else if (stale) {
        banner.hidden = false;
        inner.className = 'status-banner-inner';
        inner.querySelector('.status-banner-text').textContent = t('banner.stale', { hours: CFG.staleAfterHours, when });
    } else {
        banner.hidden = true;
    }
}
function setOffline(v) {
    if (S.offline === v) return;
    S.offline = v;
    renderFreshness();
}
function renderUpdateBanner() {
    const b = $('update-banner');
    b.hidden = !_pendingGen;
}

async function refreshStatus({ initial = false } = {}) {
    try {
        const r = await loadStatus();
        S.status = r.data;
        if (r.offline) setOffline(true);
        else if (!initial) setOffline(false);
        const gen = r.data.generated_at || null;
        if (!initial && gen && S.gen && gen !== S.gen) { _pendingGen = gen; renderUpdateBanner(); }
        renderAccuracy();
        renderFreshness();
        return gen;
    } catch (e) {
        if (!navigator.onLine) setOffline(true);
        renderFreshness();
        return null;
    }
}

async function applyUpdate() {
    if (!_pendingGen) return;
    const gen = _pendingGen;
    _pendingGen = null;
    renderUpdateBanner();
    try {
        const { index } = await loadIndex(gen);
        S.index = index;
        S.gen = gen;
        renderSpotNav();
        await openSpot(S.index.byId[S.current] ? S.current : S.index.spot_order[0]);
        if (window.Maps) Maps.onIndexChanged();
    } catch (e) {
        _pendingGen = gen;
        renderUpdateBanner();
    }
}

/* ---------- about the forecast: measured accuracy ---------- */
function renderAccuracy() {
    const el = $('accuracy-line');
    const acc = S.status && S.status.model_accuracy;
    const value = acc && typeof acc === 'object' ? Number(acc.acc) : NaN;
    if (!Number.isFinite(value)) { el.hidden = true; el.textContent = ''; return; }
    const win = Array.isArray(acc.window) ? acc.window : [];
    const fromMs = Date.parse(win[0]), toMs = Date.parse(win[1]);
    const dateOpts = { day: 'numeric', month: 'short', year: 'numeric' };
    const period = Number.isFinite(fromMs) && Number.isFinite(toMs)
        ? t('about.accPeriod', { from: fmtInstant(fromMs, 'UTC', dateOpts), to: fmtInstant(toMs, 'UTC', dateOpts) })
        : '';
    const adj = Number(acc.adjacent);
    el.textContent = t('about.accLine', {
        acc: fmtPct(value),
        n: fmtInt(acc.n_reports),
        period,
    }) + (Number.isFinite(adj) ? ' ' + t('about.accAdjacent', { adj: fmtPct(adj) }) : '');
    el.hidden = false;
}

/* ---------- tabs ---------- */
function switchView(view) {
    if (!['forecast', 'spots', 'ocean'].includes(view)) view = 'forecast';
    _view = view;
    document.querySelectorAll('[data-primary-view]').forEach(b => {
        const on = b.dataset.primaryView === view;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
    });
    $('forecast-view').hidden = view !== 'forecast';
    $('spots-map-view').hidden = view !== 'spots';
    $('direction-map-view').hidden = view !== 'ocean';
    setUrlParam('view', view === 'forecast' ? null : view);
    if (view === 'forecast') {
        if (window.Maps) Maps.stop();
        requestAnimationFrame(renderTideCanvas);
        return;
    }
    const holder = view === 'spots' ? $('conditions-map') : $('direction-map');
    loadMaps()
        .then(() => (view === 'spots' ? Maps.showSpots() : Maps.showOcean()))
        .catch(err => {
            console.error(err);
            holder.innerHTML = `<div class="map-loading-note">${escapeHtml(t('map.loadFailed'))} <button type="button" class="btn">${escapeHtml(t('common.retry'))}</button></div>`;
            holder.querySelector('button').onclick = () => { holder.innerHTML = ''; switchView(view); };
        });
}
function initTabs() {
    const tabs = [...document.querySelectorAll('[data-primary-view]')];
    tabs.forEach((b, i) => {
        b.addEventListener('click', () => switchView(b.dataset.primaryView));
        b.addEventListener('keydown', ev => {
            let n = null;
            if (ev.key === 'ArrowRight') n = (i + 1) % tabs.length;
            if (ev.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
            if (ev.key === 'Home') n = 0;
            if (ev.key === 'End') n = tabs.length - 1;
            if (n == null) return;
            ev.preventDefault();
            tabs[n].click();
            tabs[n].focus();
        });
    });
}

/* ---------- climatology (lazy) ---------- */
function initClimato() {
    const det = $('climato-details');
    det.addEventListener('toggle', () => {
        if (!det.open) return;
        loadScript(assetUrl('climato.js'))
            .then(() => Climato.open())
            .catch(() => { $('climato-status').textContent = t('climato.loadFailed'); });
    });
}

/* ---------- nearby radius pills ---------- */
function initNearbyPills() {
    document.querySelectorAll('#nearby-radius-pills .nrp').forEach(btn => {
        const km = parseInt(btn.dataset.km, 10);
        btn.setAttribute('aria-pressed', String(km === _nearbyRadiusKm));
        btn.addEventListener('click', () => {
            if (km === _nearbyRadiusKm) return;
            _nearbyRadiusKm = km;
            storeSet(NEARBY_KEY, String(km));
            document.querySelectorAll('#nearby-radius-pills .nrp').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
            if (S.spotData) renderCarousel(buildFullDayCards());
            else if (currentEntry()) renderCarousel(buildCoarseDayCards(currentEntry()));
        });
    });
}

/* ---------- tap-friendly tooltips ---------- */
function initTapTips() {
    const tip = $('tap-tip');
    let shown = false;
    const hide = () => { tip.classList.remove('show'); shown = false; };
    document.addEventListener('click', e => {
        const target = e.target.closest('.tip-target');
        if (!target) { if (shown) hide(); return; }
        const text = target.getAttribute('title') || target.getAttribute('data-tip');
        if (!text) return;
        e.preventDefault();
        tip.textContent = text;
        tip.classList.add('show');
        const r = target.getBoundingClientRect();
        let top = r.bottom + 6;
        if (top + tip.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - tip.offsetHeight - 6);
        const left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2));
        tip.style.top = top + 'px';
        tip.style.left = left + 'px';
        shown = true;
    }, true);
    document.addEventListener('scroll', () => { if (shown) hide(); }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && shown) hide(); });
}

/* ---------- language ---------- */
function initLangSwitch() {
    document.querySelectorAll('[data-set-lang]').forEach(b => {
        b.addEventListener('click', () => {
            if (b.dataset.setLang === getLang()) return;
            setLang(b.dataset.setLang);
            onLanguageChanged();
        });
    });
    syncLangButtons();
}
function syncLangButtons() {
    document.querySelectorAll('[data-set-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setLang === getLang())));
}
function onLanguageChanged() {
    applyI18n(document);
    syncLangButtons();
    renderFreshness();
    renderAccuracy();
    renderSpotNav();
    rerenderSpot();
    if (window.Maps) Maps.relabel();
    if (window.Climato) Climato.relabel();
    renderInstallUi();
}

/* ---------- install prompt ---------- */
let _deferredInstall = null;
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIos() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function renderInstallUi() {
    const btn = $('install-btn');
    btn.hidden = !_deferredInstall || isStandalone();
    const hint = $('ios-hint');
    hint.hidden = !(isIos() && !isStandalone() && !storeGet(IOS_HINT_KEY));
}
function initInstall() {
    window.addEventListener('beforeinstallprompt', e => {
        e.preventDefault();
        _deferredInstall = e;
        renderInstallUi();
    });
    window.addEventListener('appinstalled', () => { _deferredInstall = null; renderInstallUi(); });
    $('install-btn').addEventListener('click', async () => {
        if (!_deferredInstall) return;
        const ev = _deferredInstall;
        _deferredInstall = null;
        renderInstallUi();
        try { ev.prompt(); await ev.userChoice; } catch (e) { /* dismissed */ }
    });
    $('ios-hint-close').addEventListener('click', () => { storeSet(IOS_HINT_KEY, '1'); renderInstallUi(); });
    renderInstallUi();
}

/* ---------- service worker ---------- */
function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(err => console.warn('SW registration failed', err));
}
/** Ask the SW to keep the favourite spots available offline. */
function warmFavouritesCache() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller || !S.index) return;
    const conn = navigator.connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return;
    const base = new URL(CFG.dataBase, location.href);
    const urls = getFavorites().filter(id => S.index.byId[id]).slice(0, 12)
        .map(id => new URL(withVersion('spots/' + encodeURIComponent(id) + '.json', S.gen), base).href);
    if (urls.length) navigator.serviceWorker.controller.postMessage({ type: 'warm', urls });
}

/* ---------- boot ---------- */
async function loadAll() {
    const gen = await refreshStatus({ initial: true });
    let res;
    try {
        res = await loadIndex(gen);
    } catch (err) {
        console.error('Index load failed', err);
        showAppError(err, loadAll);
        return;
    }
    $('app-error').hidden = true;
    S.index = res.index;
    S.gen = gen || res.index.generated_at || null;
    if (res.offline) setOffline(true);
    renderFreshness();

    if (!storeGet(FAV_INIT_KEY)) {
        const valid = DEFAULT_FAVS.filter(id => S.index.byId[id]);
        if (valid.length && !getFavorites().length) setFavorites(valid);
        storeSet(FAV_INIT_KEY, '1');
    }
    const params = new URLSearchParams(location.search);
    const favs = getFavorites().filter(id => S.index.byId[id]);
    const requested = params.get('spot');
    const start = requested && S.index.byId[requested] ? requested : (favs[0] || S.index.spot_order[0]);
    openSpot(start);
    const view = params.get('view');
    if (view === 'map' || view === 'ocean') switchView('ocean');
    else if (view === 'spots') switchView('spots');
    setTimeout(warmFavouritesCache, 4000);
}

function boot() {
    applyI18n(document);
    initLangSwitch();
    initTabs();
    initTapTips();
    initNearbyPills();
    initClimato();
    initInstall();
    $('spot-search').addEventListener('input', e => { _searchQuery = e.target.value; renderSpotNav(); });
    $('spot-search').addEventListener('keydown', e => {
        if (e.key === 'Enter') { const first = $('spot-nav').querySelector('.spot-btn'); if (first) first.click(); }
    });
    $('fav-toggle').addEventListener('click', () => { if (S.current) toggleFavorite(S.current); });
    $('update-apply').addEventListener('click', applyUpdate);
    window.addEventListener('online', () => { setOffline(false); refreshStatus(); });
    window.addEventListener('offline', () => setOffline(true));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
    setInterval(() => { if (!document.hidden) refreshStatus(); }, 15 * 60 * 1000);
    setInterval(renderFreshness, 60 * 1000);
    initServiceWorker();
    loadAll();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
