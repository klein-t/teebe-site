// Aggregate page views, compatible with the existing /px Worker.
// Known directory campaign sources take precedence over the browser referrer.
(function () {
  try {
    if (location.hostname !== 'teebe.io') return;
    if (/[?&]dev=1/.test(location.search)) localStorage.setItem('tb_dev', '1');
    var v = sessionStorage.getItem('tb_seen') ? 0 : 1;
    if (v) sessionStorage.setItem('tb_seen', '1');
    var dev = localStorage.getItem('tb_dev') ? 1 : 0;
    var ref = '';
    try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}

    // Never forward arbitrary campaign values, full URLs, or identifiers.
    // Multiple source values are ambiguous, so use the referrer instead.
    var sources = new URLSearchParams(location.search).getAll('utm_source');
    if (sources.length === 1) {
      var source = sources[0].trim().toLowerCase().replace(/^www\./, '');
      var directories = [
        'trackawesomelist.com',
        'ripperhe.github.io',
        'wangchujiang.com',
        'lvruan.com',
        'nuanyue.com',
        'opendmg.app',
        'stillworks.dev',
        'opentoolshub.com'
      ];
      if (directories.indexOf(source) !== -1) ref = source;
    }

    // Reuse the referrer-host field, with no new storage or Worker schema.
    new Image().src = 'https://dl.teebe.io/px?p=' + encodeURIComponent(location.pathname)
      + '&v=' + v + (ref ? '&r=' + encodeURIComponent(ref) : '') + (dev ? '&dev=1' : '')
      + '&t=' + Date.now();
  } catch (e) {}
})();
