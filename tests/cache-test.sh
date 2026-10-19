#!/usr/bin/env bash
# Demonstrate CloudFront edge caching: request the same fingerprinted asset (and the leaderboard
# API) repeatedly and print the cache-related response headers. Expect the first request to be a
# Miss (edge fetches from S3/ALB) and later ones to be Hits with an increasing Age.
# Usage: tests/cache-test.sh https://<distribution>.cloudfront.net [repeats]
set -euo pipefail
BASE="${1:?usage: $0 https://<distribution>.cloudfront.net [repeats]}"
REPEATS="${2:-5}"
BASE="${BASE%/}"

asset="$(curl -fsS "$BASE/" | grep -oE 'app\.[a-f0-9]{10}\.js' | head -1)"
[[ -n "$asset" ]] || { echo "could not find fingerprinted app bundle in index.html" >&2; exit 1; }

probe() { # probe <label> <url>
    local label="$1" url="$2"
    echo "== $label: $url"
    printf '%-4s %-26s %-6s %-8s %-10s %s\n' '#' 'x-cache' 'age' 'status' 'time_s' 'cache-control'
    for i in $(seq 1 "$REPEATS"); do
        local headers status time_total
        headers="$(curl -sS -o /dev/null -D - -w 'STATUS:%{http_code} TIME:%{time_total}\n' "$url")"
        status="$(grep -o 'STATUS:[0-9]*' <<<"$headers" | cut -d: -f2)"
        time_total="$(grep -o 'TIME:[0-9.]*' <<<"$headers" | cut -d: -f2)"
        printf '%-4s %-26s %-6s %-8s %-10s %s\n' "$i" \
            "$(grep -i '^x-cache:' <<<"$headers" | cut -d' ' -f2- | tr -d '\r')" \
            "$(grep -i '^age:' <<<"$headers" | cut -d' ' -f2 | tr -d '\r')" \
            "$status" "$time_total" \
            "$(grep -i '^cache-control:' <<<"$headers" | cut -d' ' -f2- | tr -d '\r')"
        sleep 1
    done
    echo "   edge POP: $(curl -sS -o /dev/null -D - "$url" | grep -i '^x-amz-cf-pop:' | cut -d' ' -f2 | tr -d '\r')"
}

echo "Run at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
probe "fingerprinted JS bundle (S3 origin, immutable 1y)" "$BASE/$asset"
probe "leaderboard API (ALB->Lambda origin, 10 s TTL)" "$BASE/api/leaderboard?limit=10"
probe "index.html (no-cache: revalidated every time)" "$BASE/index.html"
