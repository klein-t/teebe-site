#!/usr/bin/env bash
# Query Teebe download stats from Cloudflare Analytics Engine, split by
# "user" vs "dev" (your own ?dev=1 test fetches) so you can tell them apart.
#
# Needs two env vars (get them in step 7 of the setup):
#   CF_ACCOUNT_ID  - Cloudflare account id
#   CF_API_TOKEN   - API token with "Account Analytics: Read"
#
# Usage: CF_ACCOUNT_ID=... CF_API_TOKEN=... scripts ./query.sh
set -euo pipefail

: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_API_TOKEN:?set CF_API_TOKEN}"

SQL="SELECT blob5 AS who, blob1 AS version, SUM(_sample_interval) AS downloads
     FROM teebe_downloads
     WHERE timestamp > now() - INTERVAL '90' DAY
     GROUP BY who, version
     ORDER BY who, version"

curl -s "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -d "${SQL}" | jq -r '
    (.data // []) as $d
    | if ($d|length)==0 then "no data yet"
      else (["WHO","VERSION","DOWNLOADS"], ($d[]|[.who,.version,(.downloads|floor|tostring)])) | @tsv
      end' | column -t
