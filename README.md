# teebe-site

Marketing landing page for [teebe](https://github.com/klein-t/teebe), served at
**https://teebe.io** via GitHub Pages.

Static, no build step — plain HTML/CSS. To work on it locally, open `index.html`
in a browser or run any static server (e.g. `python3 -m http.server`).

## Files

- `index.html` — the page (with SEO meta, Open Graph, Twitter cards, JSON-LD).
- `styles.css` — styling.
- `robots.txt`, `sitemap.xml` — SEO crawl files.
- `CNAME` — custom domain (`teebe.io`); read by GitHub Pages.
- `.nojekyll` — disables Jekyll processing.
- `assets/` — logo + product screenshots.

## Deploy

Pushing to `main` publishes automatically via GitHub Pages.
