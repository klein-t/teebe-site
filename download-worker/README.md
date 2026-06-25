# teebe-download — Cloudflare Worker

Counts Teebe downloads *with attribution*. GitHub Releases only gives a bare
aggregate counter (no IP / UA / who). This Worker sits in front of the download:
it logs one Analytics Engine datapoint per fetch (version, kind, country,
user-agent, and a `user`/`dev` tag) then 302-redirects to the real GitHub asset.

`?dev=1` is how you tell *yourself* apart — use it when you test; everyone else
is tagged `user`.

## Status

- [x] Worker code + `wrangler.toml` written, builds clean (`wrangler deploy --dry-run`)
- [x] wrangler installed locally (`npm install` already run here)
- [x] query script (`query.sh`) ready
- [ ] **YOU:** `wrangler login` (browser auth — can't be automated)
- [ ] **YOU:** `npm run deploy`
- [ ] **YOU:** add `dl.teebe.io` custom domain in the dashboard
- [ ] **YOU:** create an API token, then `./query.sh`
- [ ] After live: apply the `install.sh` patch below + update the web button

## Deploy

```sh
cd download-worker
npx wrangler login          # opens browser
npm run deploy              # creates the Worker + Analytics Engine dataset
```

Then in the dashboard (https://dash.cloudflare.com → teebe.io zone → Workers):
add a **Custom Domain** `dl.teebe.io` to the `teebe-download` Worker. DNS is
auto-created.

Test:
```sh
curl -sI "https://dl.teebe.io/?dev=1" | grep -i location   # -> a github.com .../teebe-vX.Y.Z.zip URL
```

## Reading stats

Create a token at https://dash.cloudflare.com/profile/api-tokens with
**Account › Account Analytics › Read**, grab your Account ID from the dashboard
sidebar, then (store these in Infisical, not a file):

```sh
CF_ACCOUNT_ID=… CF_API_TOKEN=… ./query.sh
```

## Post-deploy: route the installers through the Worker

Only after `dl.teebe.io` is confirmed live, or installs break.

**Web button** on teebe.io → point the download link at `https://dl.teebe.io/`.

**install.sh** — replace the GitHub-API lookup + download (lines ~14-29) with a
single fetch through the Worker, keeping a GitHub fallback if the Worker is down:

```sh
echo "Downloading teebe…"
if ! curl -fsSL "https://dl.teebe.io" -o "${TMP}/teebe.zip"; then
  # Fallback: resolve the latest .zip straight from GitHub.
  ZIP_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -o '"browser_download_url": *"[^"]*\.zip"' \
    | head -1 | sed 's/.*"https/https/; s/"$//')
  [ -n "${ZIP_URL}" ] || { echo "error: no .zip asset found" >&2; exit 1; }
  curl -fsSL "${ZIP_URL}" -o "${TMP}/teebe.zip"
fi
```

This change lands on `main` (it's served from `raw/main/install.sh`), so it goes
through the normal dev → main flow.

## Cost / privacy

Free tier (100k req/day, Analytics Engine free). Logs country + user-agent, not
raw IP. The install page should disclose that downloads are measured.
