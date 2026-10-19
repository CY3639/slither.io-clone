#!/usr/bin/env bash
# Smoke test of the deployed system through CloudFront: page, assets, health, API, and a real
# WebSocket session (join -> lobby -> world -> snapshots) using the load-test client.
# Usage: tests/smoke.sh https://<distribution>.cloudfront.net
set -euo pipefail
BASE="${1:?usage: $0 https://<distribution>.cloudfront.net}"; BASE="${BASE%/}"
pass=0; fail=0
check() { if [[ "$2" == $3 ]]; then echo "PASS  $1 ($2)"; pass=$((pass+1)); else echo "FAIL  $1: got '$2', expected $3"; fail=$((fail+1)); fi; }

check "index.html served" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")" 200
check "HTTP redirects to HTTPS" "$(curl -s -o /dev/null -w '%{http_code}' "${BASE/https:/http:}/")" 301
app="$(curl -fsS "$BASE/" | grep -oE 'app\.[a-f0-9]{10}\.js' | head -1)"
check "fingerprinted bundle immutable" "$(curl -sI "$BASE/$app" | grep -i '^cache-control' | tr -d '\r')" "*immutable*"
check "game /health via CloudFront" "$(curl -fsS "$BASE/health" | grep -o '"status":"ok"')" '"status":"ok"'
check "leaderboard API" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/leaderboard?limit=5")" 200
check "bad player id rejected" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/player?id=nope")" 400
bucket_host="$(curl -fsS "$BASE/status" >/dev/null && echo ok)"
check "status endpoint" "$bucket_host" ok

ws="${BASE/https:/wss:}/ws"
out="$(mktemp)"
node "$(dirname "$0")/../load-tests/websocket-load.js" --url "$ws" --clients 1 --duration 16 --ramp 0 --quiet --out "$out" >/dev/null
check "WebSocket join" "$(node -e 'console.log(require(process.argv[1]).connections.joined)' "$out")" 1
check "WebSocket snapshots received" "$(node -e 'console.log(require(process.argv[1]).gameplay.snapshots > 10 ? "yes" : "no")' "$out")" yes
rm -f "$out"
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
