/* QLog deployment configuration
   GitHub Pages frontend -> Cloudflare Tunnel backend.
   Change only this URL if the backend hostname changes later. */
(function () {
  'use strict';
  var DEFAULT_API_BASE = 'https://qlog-upgraded.mdmsportal.uk';
  var configured = (window.QLOG_CONFIG && window.QLOG_CONFIG.apiBase) || DEFAULT_API_BASE;
  var base = String(configured || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  window.QLOG_API_BASE = base;
  window.qlogApiUrl = function (path) {
    var value = String(path == null ? '' : path).trim();
    if (/^https?:\/\//i.test(value)) return value;
    value = value.replace(/^\.\//, '');
    if (value.charAt(0) !== '/') value = '/' + value;
    return base + value;
  };
})();
