/* PeakSurf /next/ — language switch for the static pages. Content for both
   languages is in the HTML ([data-lang="fr"] / [data-lang="en"]); French is
   shown when JavaScript is off. Shares the app's 'peaksurf_lang' setting. */
'use strict';
(function () {
    const KEY = 'peaksurf_lang';
    function get() {
        try { const v = localStorage.getItem(KEY); if (v === 'fr' || v === 'en') return v; } catch (e) { /* ignore */ }
        return 'en';
    }
    function apply(lang) {
        document.documentElement.lang = lang;
        document.querySelectorAll('[data-lang]').forEach(el => { el.hidden = el.getAttribute('data-lang') !== lang; });
        document.querySelectorAll('[data-set-lang]').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-set-lang') === lang)));
        const title = document.documentElement.getAttribute('data-title-' + lang);
        if (title) document.title = title;
    }
    function init() {
        apply(get());
        document.querySelectorAll('[data-set-lang]').forEach(b => b.addEventListener('click', () => {
            const lang = b.getAttribute('data-set-lang');
            try { localStorage.setItem(KEY, lang); } catch (e) { /* ignore */ }
            apply(lang);
        }));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
