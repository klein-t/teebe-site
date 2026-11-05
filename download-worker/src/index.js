// Teebe download proxy.
//
// Flow: client hits this Worker -> we look up the latest GitHub release asset,
// log one Analytics Engine datapoint (version, kind, country, UA, who), then
// 302-redirect to the real GitHub download URL.
//
// "Tell me apart": every request is classified into one `who` bucket:
//   dev     - your own test fetches (?dev=1)
//   install - a real install via teebe.io/install.sh (sends UA "teebe-install")
//   brew    - a real install via the Homebrew cask (UA "Homebrew/<ver> (...) curl/<ver>")
//   web     - everything else: browsers, bots, scanners, link-preview fetchers.
//             A brand-new public subdomain attracts a LOT of this, and a bot's
//             curl is indistinguishable from a real one, so it's bucketed
//             separately and is NOT a reliable install number. Trust "install".
//
//   https://dl.teebe.io/            -> latest .zip
//   https://dl.teebe.io/?kind=dmg   -> latest .dmg
//   https://dl.teebe.io/?dev=1      -> latest .zip   (logged as "dev" = you)
//   https://dl.teebe.io/v0.8.1/teebe-v0.8.1.zip -> that exact release asset
//     (the Homebrew cask's url). Tag and filename are strictly validated; any
//     other /v.../... path 404s. Homebrew only ever sends us a HEAD (see
//     handleVersioned), so for it the HEAD is the download; for everyone else
//     only GET counts.
//
// Page views: the HTML on teebe.io fires GET /px on each load, logged to the
// separate teebe_pageviews dataset. Only real browsers (which run JS) hit it,
// so it's far cleaner than the download "web" bucket. See handlePixel().
//
// Stats dashboard (private): https://dl.teebe.io/stats?key=<STATS_KEY>
//   Renders install/web/dev download counts AND site page views/visits, each
//   by country/day, plus top pages and referrers and recent installs.
//   Reads both datasets from Analytics Engine via the SQL API (CF_API_TOKEN).

const REPO = "klein-t/teebe";
const ACCOUNT_ID = "c98c457a0ae116da83eb79e64cb21e52";
// Your own test installs come from here, excluded from the "real install"
// counts on /stats. (Test downloads should use ?dev=1 anyway, which tags `dev`.)
const OWN_COUNTRY = "AL";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Private stats page.
    if (url.pathname === "/stats") {
      return handleStats(url, env);
    }

    // Sparkle update feed (route teebe.io/appcast.xml): count, then pass
    // through to GitHub Pages, which serves the file itself.
    if (url.pathname === "/appcast.xml") {
      return handleAppcast(url, request, env);
    }

    // Site page-view beacon. The HTML on teebe.io fires GET /px on load.
    if (url.pathname === "/px") {
      return handlePixel(url, request, env);
    }

    const ua = request.headers.get("User-Agent") || "";
    const who =
      url.searchParams.get("dev") === "1" ? "dev"
      : /teebe-install/i.test(ua) ? "install"
      : /^Homebrew\//.test(ua) ? "brew"
      : "web";

    // Versioned asset path, e.g. /v0.8.1/teebe-v0.8.1.zip (Homebrew cask).
    if (/^\/v[^/]*\//.test(url.pathname)) {
      return handleVersioned(url, request, env, who);
    }

    const kind = url.searchParams.get("kind") === "dmg" ? "dmg" : "zip";

    // Latest release metadata, cached 5 min so we don't hit GitHub's rate limit.
    // Only successful responses are cached; a rate-limited 403 must not poison
    // the cache for 5 minutes.
    const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        "User-Agent": "teebe-download-worker",
        Accept: "application/vnd.github+json",
      },
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": 300, "300-599": 0 },
      },
    }).then((r) => r.json());

    let asset = (rel.assets || []).find((a) => a.name.endsWith("." + kind));
    let version = rel.tag_name || "?";

    // Fallback when the API is rate-limited: GitHub's public releases/latest
    // page 302s to .../releases/tag/vX.Y.Z with no API quota involved. The tag
    // gives us the version, and asset names follow a fixed pattern
    // (teebe-vX.Y.Z.zip / teebe-macos.dmg).
    if (!asset) {
      const probe = await fetch(`https://github.com/${REPO}/releases/latest`, {
        redirect: "manual",
        headers: { "User-Agent": "teebe-download-worker" },
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: { "300-399": 300, "200-299": 0, "400-599": 0 },
        },
      });
      const tag = (probe.headers.get("Location") || "").split("/tag/")[1];
      if (!tag) return new Response("no matching asset on latest release", { status: 404 });
      version = tag;
      const name = kind === "dmg" ? "teebe-macos.dmg" : `teebe-${tag}.zip`;
      asset = {
        browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
      };
    }

    logDownload(env, request, version, kind, who);

    return Response.redirect(asset.browser_download_url, 302);
  },
};

// One datapoint per download. blob1=version, blob2=kind, blob3=country,
// blob4=user-agent, blob5=who. doubles[0]=1 so SUM() = download count.
function logDownload(env, request, version, kind, who) {
  if (env.DL) {
    env.DL.writeDataPoint({
      blobs: [
        version,
        kind,
        request.cf?.country || "??",
        request.headers.get("User-Agent") || "",
        who,
      ],
      indexes: [version],
      doubles: [1],
    });
  }
}

// --- Versioned downloads (Homebrew cask) ------------------------------------
// /vX.Y.Z/teebe-vX.Y.Z.zip or /vX.Y.Z/teebe-macos.dmg -> that release's asset
// on GitHub. Only these two exact shapes are accepted (the zip name must carry
// the same tag), so the redirect target can never be steered elsewhere.
const VERSIONED = /^\/(v\d{1,4}\.\d{1,4}\.\d{1,4})\/(teebe-(v\d{1,4}\.\d{1,4}\.\d{1,4})\.zip|teebe-macos\.dmg)$/;

function handleVersioned(url, request, env, who) {
  const m = VERSIONED.exec(url.pathname);
  if (!m || (m[3] && m[3] !== m[1])) {
    return new Response("Not found", { status: 404 });
  }
  const [, tag, name] = m;
  // Homebrew resolves the url with a HEAD (following our redirect), then
  // downloads straight from the resolved GitHub URL: its GET never reaches us.
  // So a Homebrew HEAD is the download (one per install/upgrade; a cached
  // reinstall also sends it). Anyone else: count GET, not HEAD probes.
  const brewUA = /^Homebrew\//.test(request.headers.get("User-Agent") || "");
  if (brewUA ? request.method === "HEAD" : request.method !== "HEAD") {
    logDownload(env, request, tag, name.endsWith(".dmg") ? "dmg" : "zip", who);
  }
  return Response.redirect(`https://github.com/${REPO}/releases/download/${tag}/${name}`, 302);
}

// --- Page-view beacon ------------------------------------------------------

// A 1x1 transparent GIF the beacon <img> loads. Returned for every /px hit so
// the browser sees a valid pixel; the point is the side-effect log below.
const PIXEL = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0, 0, 0,
  0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44,
  1, 0, 0x3b,
]);

// Log one page view, then return the pixel. Only fires from real browsers that
// run JS, so bots/scanners (which the download "web" bucket is full of) mostly
// never reach here; this is close to real human traffic.
//   blob1=path  blob2=referrer host  blob3=country  blob4=view|visit  blob5=who
//   doubles[0]=1 so SUM(_sample_interval) = page views.
// A "visit" is the first page load of a browser session (the beacon sets v=1
// once per sessionStorage), so visits ⊆ views.
function handlePixel(url, request, env) {
  const clip = (s, n) => String(s || "").slice(0, n);
  const path = clip(url.searchParams.get("p") || "/", 128);
  const ref = clip(url.searchParams.get("r") || "", 128) || "direct";
  const visit = url.searchParams.get("v") === "1" ? "visit" : "view";
  // "local" = not a real teebe.io page load: a file:// or localhost copy of the
  // site, or a beacon whose Referer is some other host. Kept out of /stats.
  let refHost = "";
  try { refHost = new URL(request.headers.get("Referer") || "").hostname; } catch (e) {}
  const local = (refHost && refHost !== "teebe.io") || path.startsWith("/Users/") || ref === "localhost";
  const who = url.searchParams.get("dev") === "1" ? "dev" : local ? "local" : "human";

  if (env.WEB) {
    env.WEB.writeDataPoint({
      blobs: [path, ref, request.cf?.country || "??", visit, who],
      indexes: [path],
      doubles: [1],
    });
  }

  return new Response(PIXEL, {
    headers: {
      "content-type": "image/gif",
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    },
  });
}

// --- Sparkle update checks --------------------------------------------------
// Sparkle sends "teebe/<version> Sparkle/<sparkleVersion>" as its User-Agent
// and checks about once a day per running install, so checks/day ~= active
// installs. Logged: blob1=app version, blob2=country, blob3=app|web (web = a
// browser/bot fetching the XML, not an install), blob4=Sparkle version.
// Nothing is stored that identifies a device or person.
// Your own Mac: `defaults write dev.teebe.app SUFeedURL "https://teebe.io/appcast.xml?dev=1"`
// makes its checks land in "dev" (country-based exclusion is unreliable when
// travelling / on VPN).
async function handleAppcast(url, request, env) {
  const ua = request.headers.get("User-Agent") || "";
  const app = /\bteebe\/([\d.]+)/i.exec(ua);
  const sparkle = /\bSparkle\/([\d.]+)/i.exec(ua);
  const who = url.searchParams.get("dev") === "1" ? "dev" : sparkle ? "app" : "web";
  if (env.UPD) {
    env.UPD.writeDataPoint({
      blobs: [app ? `v${app[1]}` : "", request.cf?.country || "??", who, sparkle ? sparkle[1] : ""],
      indexes: [who],
      doubles: [1],
    });
  }
  // Origin (GitHub Pages) serves the actual feed; never cache it here.
  return fetch(request, { cf: { cacheTtl: 0 } });
}

// --- Private stats dashboard ----------------------------------------------

async function handleStats(url, env) {
  // Gate on the secret key. Wrong/missing key looks like an ordinary 404 so the
  // route's existence isn't advertised.
  if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) {
    return new Response("Not found", { status: 404 });
  }
  if (!env.CF_API_TOKEN) {
    return new Response("stats not configured (missing CF_API_TOKEN secret)", { status: 500 });
  }

  const sql = (q) =>
    fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: q,
    })
      .then((r) => r.json())
      .then((j) => j.data || [])
      .catch(() => []);

  // Real installs (install.sh + Homebrew) exclude OWN_COUNTRY (your own tests).
  const notMine = `blob5 IN ('install','brew') AND blob3 != '${OWN_COUNTRY}'`;
  // Real page views exclude your own browsing (dev flag or OWN_COUNTRY).
  // Older datapoints predate the "local" tag: also drop local-file paths and
  // localhost referrers that were logged as "human".
  const webHuman = `blob5='human' AND blob3 != '${OWN_COUNTRY}' AND blob1 NOT LIKE '/Users/%' AND blob1 NOT LIKE '%.mockup.html' AND blob2 != 'localhost'`;
  // Active installs = Sparkle checks from real apps, your own country excluded.
  const appCheck = `blob3='app' AND blob2 != '${OWN_COUNTRY}'`;
  const [
    overview, realByWho, byCountry, recent, daily,
    webTotals, webDaily, webByPath, webRefs, webByCountry,
    updDaily, updByVersion, updByCountry,
  ] = await Promise.all([
    sql("SELECT blob5 AS who, SUM(_sample_interval) AS n FROM teebe_downloads GROUP BY who ORDER BY n DESC"),
    sql(`SELECT blob5 AS who, SUM(_sample_interval) AS n FROM teebe_downloads WHERE ${notMine} GROUP BY who`),
    sql(`SELECT blob3 AS country, SUM(_sample_interval) AS n FROM teebe_downloads WHERE ${notMine} GROUP BY country ORDER BY n DESC`),
    sql(`SELECT timestamp, blob3 AS country, blob1 AS version, blob5 AS who FROM teebe_downloads WHERE ${notMine} ORDER BY timestamp DESC LIMIT 25`),
    sql(`SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS n FROM teebe_downloads WHERE ${notMine} GROUP BY day ORDER BY day DESC LIMIT 14`),
    sql(`SELECT blob4 AS kind, SUM(_sample_interval) AS n FROM teebe_pageviews WHERE ${webHuman} GROUP BY kind`),
    sql(`SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS n FROM teebe_pageviews WHERE ${webHuman} GROUP BY day ORDER BY day DESC LIMIT 14`),
    sql(`SELECT blob1 AS path, SUM(_sample_interval) AS n FROM teebe_pageviews WHERE ${webHuman} GROUP BY path ORDER BY n DESC LIMIT 10`),
    sql(`SELECT blob2 AS ref, SUM(_sample_interval) AS n FROM teebe_pageviews WHERE ${webHuman} AND blob2 != 'direct' GROUP BY ref ORDER BY n DESC LIMIT 10`),
    sql(`SELECT blob3 AS country, SUM(_sample_interval) AS n FROM teebe_pageviews WHERE ${webHuman} GROUP BY country ORDER BY n DESC LIMIT 10`),
    sql(`SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS n FROM teebe_updates WHERE ${appCheck} GROUP BY day ORDER BY day DESC LIMIT 15`),
    sql(`SELECT blob1 AS version, SUM(_sample_interval) AS n FROM teebe_updates WHERE ${appCheck} AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY version ORDER BY n DESC LIMIT 10`),
    sql(`SELECT blob2 AS country, SUM(_sample_interval) AS n FROM teebe_updates WHERE ${appCheck} AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY country ORDER BY n DESC LIMIT 15`),
  ]);

  const html = renderStats({
    overview, realByWho, byCountry, recent, daily,
    webTotals, webDaily, webByPath, webRefs, webByCountry,
    updDaily, updByVersion, updByCountry,
  });

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Pure: query rows in, HTML out (no env, no fetch), so the page can be rendered
// locally from fixture rows. Server-side SVG/CSS charts, no external assets.
function renderStats(d, today = new Date().toISOString().slice(0, 10)) {
  const {
    overview, realByWho, byCountry, recent, daily,
    webTotals, webDaily, webByPath, webRefs, webByCountry,
    updDaily, updByVersion, updByCountry,
  } = d;

  const num = (v) => Math.floor(Number(v) || 0);

  // Headline: average checks per full day over the last 7 complete days
  // (today is partial, so it's skipped). ~= installs that ran the app daily.
  const fullDays = updDaily.filter((r) => String(r.day) < today).slice(0, 7);
  const activeAvg = fullDays.length
    ? Math.round(fullDays.reduce((s, r) => s + num(r.n), 0) / fullDays.length)
    : 0;
  const activeYesterday = fullDays.length ? num(fullDays[0].n) : 0;

  const counts = Object.fromEntries(overview.map((r) => [r.who, num(r.n)]));
  // Install headline = real installs only (your OWN_COUNTRY tests excluded).
  const installs = byCountry.reduce((s, r) => s + num(r.n), 0);
  const real = Object.fromEntries(realByWho.map((r) => [r.who, num(r.n)]));

  // Page views: total = every load; visits = first load per session (kind=visit).
  const webKind = Object.fromEntries(webTotals.map((r) => [r.kind, num(r.n)]));
  const views = (webKind.view || 0) + (webKind.visit || 0);
  const visits = webKind.visit || 0;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const empty = (text = "nessuna") => `<p class="empty">${text}</p>`;

  // Daily rows (newest first, days without data absent) -> oldest-first series
  // with every calendar day up to today, missing days as 0. Presentation only.
  const fillDays = (rows) => {
    const m = new Map(rows.map((r) => [String(r.day).slice(0, 10), num(r.n)]));
    const keys = [...m.keys()].sort();
    if (!keys.length) return [];
    const start = Date.parse(keys[0] + "T00:00:00Z");
    const end = keys[keys.length - 1] > today ? keys[keys.length - 1] : today;
    if (Number.isNaN(start)) return keys.map((day) => ({ day, n: m.get(day) }));
    const out = [];
    for (let t = start, i = 0; i < 400; t += 86400000, i++) {
      const day = new Date(t).toISOString().slice(0, 10);
      out.push({ day, n: m.get(day) || 0 });
      if (day >= end) break;
    }
    return out;
  };
  const installSeries = fillDays(daily);
  const updSeries = fillDays(updDaily);
  const webSeries = fillDays(webDaily);

  // Clean axis: step from 1/2/5 x 10^k so the top tick is <= 4 steps.
  const scale = (max) => {
    if (max <= 0) return { top: 1, step: 1 };
    const mag = 10 ** Math.floor(Math.log10(max));
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10].map((f) => Math.max(1, f * mag)).find((s) => max / s <= 4);
    return { top: Math.ceil(max / step) * step, step };
  };
  const ddmm = (day) => (/^\d{4}-\d{2}-\d{2}/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : day);

  // Daily column chart. Width is in % so it fits any screen; heights in px so
  // text and corners stay crisp. Today's (partial) column is lighter.
  const columns = (series, unit) => {
    if (!series.length) return empty();
    const PT = 20, H = 150, XB = 24, total = PT + H + XB;
    const max = Math.max(...series.map((r) => r.n));
    const { top, step } = scale(max);
    const n = series.length;
    const slot = 100 / n;
    const bw = slot * 0.5;
    const y = (v) => PT + H - (v / top) * H;
    const ticks = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    const maxI = series.findIndex((r) => r.n === max);
    const labelEvery = Math.ceil(n / 7);
    const pct = (v) => `${v.toFixed(3)}%`;
    const bars = series.map((r, i) => {
      const h = (r.n / top) * H;
      const x = i * slot + (slot - bw) / 2;
      const cls = r.day === today ? "bar partial" : "bar";
      const mark = r.n > 0
        ? `<rect class="${cls}" x="${pct(x)}" y="${y(r.n)}" width="${pct(bw)}" height="${h}" rx="4"/>` +
          `<rect class="${cls}" x="${pct(x)}" y="${PT + H - Math.min(h, 4)}" width="${pct(bw)}" height="${Math.min(h, 4)}"/>`
        : "";
      const cap = (r.n > 0 && (i === maxI || i === n - 1))
        ? `<text class="cap" x="${pct(i * slot + slot / 2)}" y="${y(r.n) - 6}">${r.n}</text>` : "";
      const xl = (n - 1 - i) % labelEvery === 0
        ? `<text class="xl" x="${pct(i * slot + slot / 2)}" y="${PT + H + 17}">${esc(ddmm(r.day))}</text>` : "";
      const tip = `${r.day}${r.day === today ? " (oggi, parziale)" : ""}: ${r.n} ${unit}`;
      return `<g class="col"><title>${esc(tip)}</title><rect class="hit" x="${pct(i * slot)}" y="0" width="${pct(slot)}" height="${PT + H}"/>${mark}${cap}${xl}</g>`;
    }).join("");
    const grid = ticks.map((v) => `<line class="${v === 0 ? "axis" : "grid"}" x1="0" x2="100%" y1="${y(v)}" y2="${y(v)}"/>`).join("");
    const yl = ticks.map((v) => `<span style="top:${y(v)}px">${v}</span>`).join("");
    const table = series.slice().reverse().map((r) => `<tr><td>${esc(r.day)}</td><td class="r">${r.n}</td></tr>`).join("");
    return `<div class="chart"><div class="yax" style="height:${total}px" aria-hidden="true">${yl}</div>` +
      `<svg class="cols" height="${total}" role="img" aria-label="${esc(unit)} per giorno">${grid}${bars}</svg></div>` +
      `<details><summary>Tabella</summary><table><thead><tr><th>Giorno</th><th class="r">${esc(unit)}</th></tr></thead><tbody>${table}</tbody></table></details>`;
  };

  // Tiny trend line for the overview tiles (last 14 days, no axis).
  const spark = (series) => {
    const s = series.slice(-14);
    if (s.length < 2) return "";
    const max = Math.max(1, ...s.map((r) => r.n));
    const pts = s.map((r, i) => `${((i / (s.length - 1)) * 100).toFixed(2)},${(30 - (r.n / max) * 27).toFixed(2)}`);
    return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">` +
      `<polygon class="wash" points="0,32 ${pts.join(" ")} 100,32"/>` +
      `<polyline points="${pts.join(" ")}" vector-effect="non-scaling-stroke"/></svg>`;
  };

  // Horizontal bar list (countries, versions, pages, referrers).
  const hbars = (list, k, unit, emptyText = "nessuna") => {
    if (!list.length) return empty(emptyText);
    const max = Math.max(1, ...list.map((r) => num(r.n)));
    return `<ul class="hbars">${list.map((r) => {
      const v = num(r.n);
      return `<li title="${esc(r[k])}: ${v} ${esc(unit)}"><div class="row"><span class="k">${esc(r[k])}</span><span class="v">${v}</span></div>` +
        `<div class="track"><div class="fill" style="width:${v > 0 ? Math.max(1.5, (v / max) * 100).toFixed(2) : 0}%"></div></div></li>`;
    }).join("")}</ul>`;
  };

  const stat = (label, value, hl = false) =>
    `<div class="stat${hl ? " hl" : ""}"><div class="label">${label}</div><div class="value">${value}</div></div>`;

  const recentTable = recent.length
    ? `<div class="scroll"><table class="compact"><thead><tr><th>Quando (UTC)</th><th>Paese</th><th>Versione</th><th>Fonte</th></tr></thead><tbody>${
      recent.map((r) => `<tr><td>${esc(r.timestamp)}</td><td>${esc(r.country)}</td><td>${esc(r.version)}</td><td>${esc(r.who)}</td></tr>`).join("")
    }</tbody></table></div>`
    : empty();

  const tile = (tab, label, value, sub, series) =>
    `<a class="tile" href="#${tab}" data-go="${tab}"><div class="label">${label}</div><div class="hero">${value}</div>` +
    `<div class="tsub">${sub}</div>${spark(series)}<div class="more">Dettagli →</div></a>`;

  const html = `<!DOCTYPE html>
<html lang="it"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>teebe · stats</title>
<style>
  :root { color-scheme:light; --page:#f9f9f7; --card:#fcfcfb; --border:rgba(11,11,11,.10); --text:#0b0b0b; --text2:#52514e; --muted:#898781;
    --grid:#e1e0d9; --axis:#c3c2b7; --series:#2a78d6; --series-hover:#1c5cab; --series-partial:#9ec5f4; --track:#e6eefa; --wash:rgba(11,11,11,.04); }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme:dark; --page:#0d0d0d; --card:#1a1a19; --border:rgba(255,255,255,.10); --text:#f0efec; --text2:#c3c2b7; --muted:#898781;
      --grid:#2c2c2a; --axis:#383835; --series:#3987e5; --series-hover:#6da7ec; --series-partial:#1c4a80; --track:#1f2a38; --wash:rgba(255,255,255,.05); }
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--page); color:var(--text); line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:880px; margin:0 auto; padding:20px 16px 32px; }
  header h1 { font-size:1.25rem; font-weight:650; }
  nav { position:sticky; top:0; z-index:2; background:var(--page); border-bottom:1px solid var(--border); margin:12px -16px 20px; padding:0 16px; }
  nav .tabs { display:flex; gap:4px; max-width:880px; margin:0 auto; overflow-x:auto; scrollbar-width:none; }
  nav a { flex:0 0 auto; padding:10px 12px; color:var(--text2); text-decoration:none; font-size:.92rem; font-weight:500; border-bottom:2px solid transparent; margin-bottom:-1px; }
  nav a:hover { color:var(--text); }
  nav a[aria-selected="true"] { color:var(--text); border-bottom-color:var(--series); }
  .sub { color:var(--text2); font-size:.88rem; margin-bottom:16px; }
  .note { color:var(--muted); font-size:.8rem; margin-top:10px; }
  code { font-size:.85em; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
  .tile { display:block; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px 18px 12px; color:inherit; text-decoration:none; }
  .tile:hover { border-color:var(--axis); }
  .tile .hero { font-size:3rem; font-weight:650; line-height:1.1; margin-top:4px; }
  .tile .tsub { color:var(--text2); font-size:.85rem; margin-top:2px; }
  .tile .more { color:var(--muted); font-size:.78rem; margin-top:6px; }
  .label { color:var(--text2); font-size:.8rem; }
  .spark { display:block; width:100%; height:32px; margin-top:12px; }
  .spark polyline { fill:none; stroke:var(--series); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .spark .wash { fill:var(--series); opacity:.1; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin-bottom:16px; }
  .stat { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:12px 14px; }
  .stat .value { font-size:1.6rem; font-weight:650; margin-top:2px; }
  .stat.hl .value { font-size:2rem; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; margin-top:14px; }
  .card h2 { font-size:.95rem; font-weight:600; margin-bottom:12px; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr)); gap:0 14px; }
  .grid2 > * { min-width:0; }
  .chart { display:flex; gap:6px; }
  .yax { position:relative; width:26px; flex:0 0 auto; }
  .yax span { position:absolute; right:0; transform:translateY(-50%); font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
  svg.cols { flex:1 1 auto; min-width:0; width:100%; overflow:visible; display:block; }
  .cols .grid { stroke:var(--grid); stroke-width:1; shape-rendering:crispEdges; }
  .cols .axis { stroke:var(--axis); stroke-width:1; shape-rendering:crispEdges; }
  .cols .bar { fill:var(--series); }
  .cols .bar.partial { fill:var(--series-partial); }
  .cols .hit { fill:transparent; }
  .cols .col:hover .hit { fill:var(--wash); }
  .cols .col:hover .bar { fill:var(--series-hover); }
  .cols text { font-size:11px; text-anchor:middle; font-variant-numeric:tabular-nums; }
  .cols .cap { fill:var(--text); font-weight:600; }
  .cols .xl { fill:var(--muted); }
  details { margin-top:10px; }
  summary { cursor:pointer; color:var(--muted); font-size:.8rem; }
  details table { margin-top:8px; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--grid); }
  th { color:var(--muted); font-weight:500; font-size:.75rem; }
  tr:last-child td { border-bottom:none; }
  td.r,th.r { text-align:right; font-variant-numeric:tabular-nums; }
  .scroll { overflow-x:auto; }
  table.compact td { white-space:nowrap; font-variant-numeric:tabular-nums; }
  .hbars { list-style:none; display:grid; grid-template-columns:minmax(0,1fr); gap:10px; }
  .hbars .row { display:flex; justify-content:space-between; gap:12px; font-size:.86rem; }
  .hbars .k { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .hbars .v { font-variant-numeric:tabular-nums; font-weight:600; }
  .hbars .track { height:8px; border-radius:4px; background:var(--track); margin-top:4px; overflow:hidden; }
  .hbars .fill { height:100%; border-radius:4px; background:var(--series); }
  .hbars li:hover .fill { background:var(--series-hover); }
  .empty { color:var(--muted); font-size:.88rem; }
  footer { color:var(--muted); font-size:.78rem; margin-top:28px; }
</style></head><body>
<div class="wrap">
  <header><h1>teebe · stats</h1></header>
  <nav><div class="tabs" role="tablist">
    <a href="#panoramica" data-tab="panoramica" role="tab" aria-selected="true">Panoramica</a>
    <a href="#installazioni" data-tab="installazioni" role="tab" aria-selected="false">Installazioni</a>
    <a href="#attive" data-tab="attive" role="tab" aria-selected="false">Attive</a>
    <a href="#sito" data-tab="sito" role="tab" aria-selected="false">Sito</a>
  </div></nav>

  <section id="tab-panoramica" role="tabpanel">
    <div class="tiles">
      ${tile("installazioni", "Install reali", installs, `install.sh ${real.install || 0} · Homebrew ${real.brew || 0}`, installSeries)}
      ${tile("attive", "Attive (media 7gg)", activeAvg, `Ieri ${activeYesterday}`, updSeries)}
      ${tile("sito", "Visualizzazioni", views, `Visite ${visits}`, webSeries)}
    </div>
    <p class="note">Linee: ultimi 14 giorni (UTC). Esclusi i tuoi test (paese ${esc(OWN_COUNTRY)}) e <code>?dev=1</code>. Rumore download: web/bot ${counts.web || 0}, dev ${counts.dev || 0}.</p>
  </section>

  <section id="tab-installazioni" role="tabpanel">
    <p class="sub">Installazioni reali = <b>install</b> (UA <code>teebe-install</code>) + <b>brew</b> (Homebrew cask, UA <code>Homebrew/…</code>). <b>web</b> = browser/bot (rumore).</p>
    <div class="stats">
      ${stat("Install", installs, true)}
      ${stat("install.sh", real.install || 0)}
      ${stat("Homebrew", real.brew || 0)}
      ${stat("Web / bot", counts.web || 0)}
      ${stat("Dev (test)", counts.dev || 0)}
    </div>
    <div class="card"><h2>Installazioni per giorno (UTC)</h2>${columns(installSeries, "Install")}</div>
    <div class="card"><h2>Installazioni per paese</h2>${hbars(byCountry, "country", "install")}
      <p class="note">I tuoi test (paese ${esc(OWN_COUNTRY)}) sono esclusi ovunque qui. Per testare usa <code>?dev=1</code>, così finiscono in “dev”.</p></div>
    <div class="card"><h2>Ultime installazioni</h2>${recentTable}</div>
  </section>

  <section id="tab-attive" role="tabpanel">
    <p class="sub">Controlli aggiornamenti Sparkle su <code>teebe.io/appcast.xml</code>: ogni app aperta ne fa ~1 al giorno, quindi <b>check/giorno ≈ installazioni attive</b>. Install cumulativi − attive ≈ disinstallate o non usate.</p>
    <div class="stats">
      ${stat("Attive (media 7gg)", activeAvg, true)}
      ${stat("Ieri", activeYesterday)}
    </div>
    <div class="card"><h2>Check per giorno (UTC)</h2>${columns(updSeries, "Check")}
      <p class="note">Oggi (colonna attenuata) è parziale ed è escluso dalla media.</p></div>
    <div class="grid2">
      <div class="card"><h2>Versioni in uso (ultimi 7 giorni)</h2>${hbars(updByVersion, "version", "check")}</div>
      <div class="card"><h2>Paesi (ultimi 7 giorni)</h2>${hbars(updByCountry, "country", "check")}</div>
    </div>
    <p class="note">Solo UA Sparkle (app vere); browser e bot che leggono l'XML sono esclusi, come il paese ${esc(OWN_COUNTRY)}.</p>
  </section>

  <section id="tab-sito" role="tabpanel">
    <p class="sub">Visite reali al sito (beacon JS su teebe.io). Solo browser veri: i bot non eseguono JS, quindi quasi non compaiono.</p>
    <div class="stats">
      ${stat("Visualizzazioni", views, true)}
      ${stat("Visite", visits)}
    </div>
    <div class="card"><h2>Visualizzazioni per giorno (UTC)</h2>${columns(webSeries, "Views")}</div>
    <div class="card"><h2>Pagine più viste</h2>${hbars(webByPath, "path", "views")}</div>
    <div class="grid2">
      <div class="card"><h2>Provenienza (referrer)</h2>${hbars(webRefs, "ref", "views", "nessuno (tutto diretto)")}</div>
      <div class="card"><h2>Visite per paese</h2>${hbars(webByCountry, "country", "views")}</div>
    </div>
    <p class="note">Le tue visite (paese ${esc(OWN_COUNTRY)}) e quelle con <code>?dev=1</code> sono escluse.</p>
  </section>

  <footer>Aggiornato in tempo reale da Cloudflare Analytics Engine · +2h per ora locale (AL).</footer>
</div>
<script>
(() => {
  // Tabs: no reload; the active tab lives in the URL hash so ?key= stays put.
  const ids = ["panoramica", "installazioni", "attive", "sito"];
  const show = () => {
    const h = location.hash.slice(1);
    const cur = ids.includes(h) ? h : "panoramica";
    for (const id of ids) {
      document.getElementById("tab-" + id).hidden = id !== cur;
      document.querySelector('[data-tab="' + id + '"]').setAttribute("aria-selected", String(id === cur));
    }
  };
  document.querySelectorAll("[data-tab],[data-go]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", "#" + (a.dataset.tab || a.dataset.go));
    show();
    window.scrollTo(0, 0);
  }));
  addEventListener("hashchange", show);
  show();
})();
</script>
</body></html>`;

  return html;
}
