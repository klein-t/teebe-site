// Teebe download proxy.
//
// Flow: client hits this Worker -> we look up the latest GitHub release asset,
// log one Analytics Engine datapoint (version, kind, country, UA, who), then
// 302-redirect to the real GitHub download URL.
//
// "Tell me apart": append ?dev=1 when YOU test. Those rows are tagged "dev";
// everyone else is "user". So your own fetches never pollute the real count.
//
//   https://dl.teebe.io/            -> latest .zip   (logged as "user")
//   https://dl.teebe.io/?kind=dmg   -> latest .dmg
//   https://dl.teebe.io/?dev=1      -> latest .zip   (logged as "dev" = you)

const REPO = "klein-t/teebe";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") === "dmg" ? "dmg" : "zip";
    const who = url.searchParams.get("dev") === "1" ? "dev" : "user";

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
