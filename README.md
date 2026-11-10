# teebe-site

Marketing landing page for [teebe](https://github.com/klein-t/teebe), served at
**https://teebe.io** via GitHub Pages.

Static, no build step: plain HTML/CSS. To work on it locally, open `index.html`
in a browser or run any static server (e.g. `python3 -m http.server`).

## Files

- `index.html`: the page (with SEO meta, Open Graph, Twitter cards, JSON-LD).
- `styles.css`: styling.
- `robots.txt`, `sitemap.xml`: SEO crawl files.
- `CNAME`: custom domain (`teebe.io`); read by GitHub Pages.
- `.nojekyll`: disables Jekyll processing.
- `assets/`: logo + product screenshots.
- `assets/analytics.js`: shared aggregate page-view beacon.

Public pages use directory URLs (for example, `/privacy/` served from
`privacy/index.html`). Use those URLs in links, canonical metadata, and the
sitemap; keep redirects when replacing an existing page URL.

## Directory visit attribution

Every tracked page loads `/assets/analytics.js`. A single `utm_source` matching
one of the directory domains listed in that script takes precedence over the
browser referrer. Case, surrounding whitespace, and a leading `www.` are
normalized. Unknown or duplicate sources fall back to the browser referrer.

For example, `/?utm_source=opentoolshub.com` records `opentoolshub.com` even when
the inbound link uses `noreferrer`. The beacon sends the recognized domain in
the existing `/px?r=...` field, so the current Worker and its referrer table
already accept it. No Worker deployment or dataset migration is required.

This measures page visits, not completed installs. Attribution is per page;
campaign sources are not persisted across navigation. Links that suppress
referrers without a recognized source tag still appear as direct traffic.
Historical direct traffic cannot be recovered. No full query strings or new
visitor identifiers are recorded.

Run the regression checks with `node --test tests/analytics.test.cjs` (Node 22+).
Local previews send no beacon; production checks must use `?dev=1`.

## Deploy

Pushing to `main` publishes automatically via GitHub Pages.
