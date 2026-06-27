// Teebe download proxy.
//
// Flow: client hits this Worker -> we look up the latest GitHub release asset,
// log one Analytics Engine datapoint (version, kind, country, UA, who), then
// 302-redirect to the real GitHub download URL.
//
// "Tell me apart" — every request is classified into one `who` bucket:
//   dev     - your own test fetches (?dev=1)
//   install - a real install via teebe.io/install.sh (sends UA "teebe-install")
//   web     - everything else: browsers, bots, scanners, link-preview fetchers.
//             A brand-new public subdomain attracts a LOT of this, and a bot's
//             curl is indistinguishable from a real one — so it's bucketed
//             separately and is NOT a reliable install number. Trust "install".
//
//   https://dl.teebe.io/            -> latest .zip
//   https://dl.teebe.io/?kind=dmg   -> latest .dmg
//   https://dl.teebe.io/?dev=1      -> latest .zip   (logged as "dev" = you)
//
// Stats dashboard (private): https://dl.teebe.io/stats?key=<STATS_KEY>
//   Renders install/web/dev counts, installs by country, and recent installs.
//   Reads Analytics Engine via the SQL API using the CF_API_TOKEN secret.

const REPO = "klein-t/teebe";
const ACCOUNT_ID = "c98c457a0ae116da83eb79e64cb21e52";
// Your own test installs come from here — excluded from the "real install"
// counts on /stats. (Test downloads should use ?dev=1 anyway, which tags `dev`.)
const OWN_COUNTRY = "AL";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Private stats page.
    if (url.pathname === "/stats") {
      return handleStats(url, env);
    }

    const kind = url.searchParams.get("kind") === "dmg" ? "dmg" : "zip";

    const ua = request.headers.get("User-Agent") || "";
    const who =
      url.searchParams.get("dev") === "1" ? "dev"
      : /teebe-install/i.test(ua) ? "install"
      : "web";

    // Latest release metadata, cached 5 min so we don't hit GitHub's rate limit.
    const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        "User-Agent": "teebe-download-worker",
        Accept: "application/vnd.github+json",
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    }).then((r) => r.json());

    const asset = (rel.assets || []).find((a) => a.name.endsWith("." + kind));
    if (!asset) return new Response("no matching asset on latest release", { status: 404 });

    // One datapoint per download. blob1=version, blob2=kind, blob3=country,
    // blob4=user-agent, blob5=who. doubles[0]=1 so SUM() = download count.
    if (env.DL) {
      env.DL.writeDataPoint({
        blobs: [
          rel.tag_name || "?",
          kind,
          request.cf?.country || "??",
          request.headers.get("User-Agent") || "",
          who,
        ],
        indexes: [rel.tag_name || "?"],
        doubles: [1],
      });
    }

    return Response.redirect(asset.browser_download_url, 302);
  },
};

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

  const num = (v) => Math.floor(Number(v) || 0);

  // Real installs exclude OWN_COUNTRY (your own tests).
  const notMine = `blob5='install' AND blob3 != '${OWN_COUNTRY}'`;
  const [overview, byCountry, recent, daily] = await Promise.all([
    sql("SELECT blob5 AS who, SUM(_sample_interval) AS n FROM teebe_downloads GROUP BY who ORDER BY n DESC"),
    sql(`SELECT blob3 AS country, SUM(_sample_interval) AS n FROM teebe_downloads WHERE ${notMine} GROUP BY country ORDER BY n DESC`),
    sql(`SELECT timestamp, blob3 AS country, blob1 AS version FROM teebe_downloads WHERE ${notMine} ORDER BY timestamp DESC LIMIT 25`),
    sql(`SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS n FROM teebe_downloads WHERE ${notMine} GROUP BY day ORDER BY day DESC LIMIT 14`),
  ]);

  const counts = Object.fromEntries(overview.map((r) => [r.who, num(r.n)]));
  // Install headline = real installs only (your OWN_COUNTRY tests excluded).
  const installs = byCountry.reduce((s, r) => s + num(r.n), 0);

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const countryRows = byCountry.length
    ? byCountry.map((r) => `<tr><td>${esc(r.country)}</td><td class="r">${num(r.n)}</td></tr>`).join("")
    : `<tr><td colspan="2" class="muted">nessuna</td></tr>`;

  const recentRows = recent.length
    ? recent.map((r) => `<tr><td>${esc(r.timestamp)} UTC</td><td>${esc(r.country)}</td><td>${esc(r.version)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">nessuna</td></tr>`;

  const dailyRows = daily.length
    ? daily.map((r) => `<tr><td>${esc(r.day)}</td><td class="r">${num(r.n)}</td></tr>`).join("")
    : `<tr><td colspan="2" class="muted">nessuna</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="it"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>teebe · stats</title>
<style>
  :root { --bg:#0a0a0b; --card:#161618; --border:#26262a; --text:#ededef; --muted:#86868b; --green:#30d158; --accent:#0a84ff; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif; background:var(--bg); color:var(--text); line-height:1.5; padding:24px; max-width:680px; margin:0 auto; -webkit-font-smoothing:antialiased; }
  h1 { font-size:1.4rem; margin-bottom:4px; }
  .sub { color:var(--muted); font-size:.85rem; margin-bottom:24px; }
  .big { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:28px; }
  .stat { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px 20px; flex:1; min-width:120px; }
  .stat .label { color:var(--muted); font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
  .stat .value { font-size:2.2rem; font-weight:650; margin-top:4px; }
  .stat.hl .value { color:var(--green); }
  h2 { font-size:1rem; margin:24px 0 10px; color:var(--text); }
  table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--border); border-radius:12px; overflow:hidden; font-size:.9rem; }
  th,td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:500; font-size:.78rem; text-transform:uppercase; letter-spacing:.03em; }
  tr:last-child td { border-bottom:none; }
  td.r,th.r { text-align:right; }
  .muted { color:var(--muted); }
  .note { color:var(--muted); font-size:.8rem; margin-top:8px; }
  footer { color:var(--muted); font-size:.78rem; margin-top:32px; }
</style></head><body>
  <h1>teebe · download stats</h1>
  <p class="sub">Installazioni reali = riga <b>install</b> (UA <code>teebe-install</code>). <b>web</b> = browser/bot (rumore).</p>

  <div class="big">
    <div class="stat hl"><div class="label">Install</div><div class="value">${installs}</div></div>
    <div class="stat"><div class="label">Web / bot</div><div class="value">${counts.web || 0}</div></div>
    <div class="stat"><div class="label">Dev (test)</div><div class="value">${counts.dev || 0}</div></div>
  </div>

  <h2>Installazioni per paese</h2>
  <table><thead><tr><th>Paese</th><th class="r">Install</th></tr></thead><tbody>${countryRows}</tbody></table>
  <p class="note">I tuoi test (paese ${esc(OWN_COUNTRY)}) sono esclusi ovunque qui. Per testare usa <code>?dev=1</code>, così finiscono in “dev”.</p>

  <h2>Installazioni per giorno (UTC)</h2>
  <table><thead><tr><th>Giorno</th><th class="r">Install</th></tr></thead><tbody>${dailyRows}</tbody></table>

  <h2>Ultime installazioni</h2>
  <table><thead><tr><th>Quando (UTC)</th><th>Paese</th><th>Versione</th></tr></thead><tbody>${recentRows}</tbody></table>

  <footer>Aggiornato in tempo reale da Cloudflare Analytics Engine · +2h per ora locale (AL).</footer>
</body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
