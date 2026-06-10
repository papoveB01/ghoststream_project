/* DealScope landing — scroll telemetry reveals.
   Progressive enhancement: reveal attributes are added at runtime, so with
   JS disabled (or reduced-motion) every element renders fully visible. */
(function () {
  'use strict';

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    // Standalone elements that rise on their own.
    var solo = document.querySelectorAll('.section-head, .cta-card, .logos-row');
    // Grids whose children stagger in.
    var grids = document.querySelectorAll('.pillars, .features, .steps, .pricing, .stats, .addons');

    var targets = [];
    solo.forEach(function (el) { el.setAttribute('data-reveal', ''); targets.push(el); });
    grids.forEach(function (el) {
      el.setAttribute('data-reveal', '');
      el.setAttribute('data-reveal-stagger', '');
      targets.push(el);
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });

    targets.forEach(function (el) { io.observe(el); });
  });
})();
