/* PeakSurf /next/ — live camera component.
   Behaviour is unchanged from web/classic-live: GoSurf camera pages whose id
   is listed in live-preview/camera-streams.js are played muted in
   live-preview/player.html (HLS from the provider's CDN); other cameras get
   a link-out to the provider page. */
// RIGHTS: embedded third-party streams (GoSurf/Viewsurf) — owner decision 2026-09-27: keep the embeds
'use strict';

const Webcam = (() => {
    let streamsPromise = null;
    let lastState = null;   // {badge, status} i18n keys, for re-render on language change

    function loadStreams() {
        if (window.PEAKSURF_CAMERA_STREAMS) return Promise.resolve(window.PEAKSURF_CAMERA_STREAMS);
        if (streamsPromise) return streamsPromise;
        streamsPromise = new Promise(resolve => {
            const s = document.createElement('script');
            s.src = CFG.cameraStreamsUrl;
            s.async = true;
            s.onload = () => resolve(window.PEAKSURF_CAMERA_STREAMS || {});
            s.onerror = () => { streamsPromise = null; resolve({}); };
            document.head.appendChild(s);
        });
        return streamsPromise;
    }

    function directSource(webcamUrl, streams) {
        const m = String(webcamUrl || '').match(/gosurf\.fr\/webcam\/[^/]+\/(\d+)(?:\/|$)/);
        return m && streams ? streams[m[1]] : null;
    }

    function els() {
        return {
            section: document.getElementById('live-camera-section'),
            frame: document.getElementById('live-camera-frame'),
            empty: document.getElementById('live-camera-empty'),
            link: document.getElementById('webcam-link'),
            status: document.getElementById('live-camera-status'),
            badge: document.getElementById('live-camera-badge-text'),
            layout: document.getElementById('decision-layout'),
        };
    }

    function setState(badgeKey, statusKey) {
        lastState = { badgeKey, statusKey };
        const e = els();
        if (e.badge) e.badge.textContent = t(badgeKey);
        if (e.status) e.status.textContent = t(statusKey);
    }

    let renderToken = 0;
    async function render(webcamUrl, spotName) {
        const e = els();
        if (!e.section || !e.frame) return;
        const token = ++renderToken;
        if (!webcamUrl) {
            e.section.hidden = true;
            if (e.layout) e.layout.classList.add('no-camera');
            e.frame.removeAttribute('src');
            return;
        }
        e.section.hidden = false;
        if (e.layout) e.layout.classList.remove('no-camera');
        e.link.href = webcamUrl;
        e.frame.title = t('cam.frameTitle', { name: spotName || '' });
        const streams = await loadStreams();
        if (token !== renderToken) return;
        const source = directSource(webcamUrl, streams);
        if (source) {
            const playerUrl = `${CFG.cameraPlayerUrl}?source=${encodeURIComponent(source)}`;
            e.frame.hidden = false;
            e.empty.hidden = true;
            setState('cam.badgeLive', 'cam.starting');
            if (e.frame.getAttribute('src') !== playerUrl) e.frame.src = playerUrl;
            return;
        }
        e.frame.removeAttribute('src');
        e.frame.hidden = true;
        e.empty.hidden = false;
        e.empty.textContent = t('cam.noEmbed');
        setState('cam.badgeCamera', 'cam.linkOnly');
    }

    function relabel() {
        const e = els();
        if (lastState) setState(lastState.badgeKey, lastState.statusKey);
        if (e.empty && !e.empty.hidden) e.empty.textContent = t('cam.noEmbed');
    }

    window.addEventListener('message', event => {
        const frame = document.getElementById('live-camera-frame');
        if (event.origin !== window.location.origin || !frame || event.source !== frame.contentWindow) return;
        if (!event.data || event.data.scope !== 'peaksurf-camera') return;
        if (event.data.type === 'playing') setState('cam.badgeLive', 'cam.playing');
        else if (event.data.type === 'blocked') setState(lastState ? lastState.badgeKey : 'cam.badgeLive', 'cam.blocked');
        else if (event.data.type === 'error') setState('cam.badgeOffline', 'cam.unavailable');
    });

    return { render, relabel };
})();
