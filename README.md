# Battle Snake — cloud-native multiplayer Slither.io (CAB432 Assessment 3, n5528712)

A server-authoritative multiplayer version of Loonride's Phaser Slither.io tutorial clone, deployed
on AWS to demonstrate container compute with ECS Service Auto Scaling, load distribution, edge
caching, WebSockets, asynchronous event processing and structured persistence.

* **Live:** `https://d3riy98bj197ur.cloudfront.net/` (while deployed)
* **Original game:** `slither-io/` and `part-*/` are the untouched upstream tutorial
  ([Loonride, 2017](https://github.com/Loonride/slither.io-clone)). Its sprites, Phaser CE 2.6.2
  renderer, movement constants, growth, death and food-drop rules are reused. P2 physics was
  replaced by a headless server simulation.

## Architecture

```
Browser (Phaser 2 renderer, input, interpolation)
   │ HTTPS / WSS (one origin)
   ▼
CloudFront ──(OAC)──► S3            static client (fingerprinted, 1-year immutable cache)
   │ /ws, /api/*, /health, /status + secret origin header
   ▼
ALB ──► ECS Fargate service (1–6 tasks, arm64)     one task = one authoritative world (≤4 humans + NPCs = 50 snakes)
   │         │ domain events (PLAYER_DIED, SESSION_ENDED, WORLD_STARTED, WORLD_COMPLETED)
   │         ▼
   │       SQS (+DLQ) ──► Lambda event worker ──► DynamoDB (single table + leaderboard GSI)
   └──► Lambda leaderboard API ◄────────────────────────┘   (edge-cached 10 s)
CloudWatch: JSON logs, EMF custom metrics (occupancy, tick time…), dashboard, alarms
ECS Service Auto Scaling: target tracking on WorldOccupancyPct (75 %) and CPU (50 %)
```

Design documents: [`docs/`](docs/), covering requirements, the vendor-agnostic and AWS architectures,
the assessment pattern matrix, the evidence register and final test results.

## Repository layout

| Path | What |
|------|------|
| `server/` | Node.js 22 game server: world simulation, lobby/room, WebSocket protocol, SQS publisher, metrics, Dockerfile |
| `client/` | Phaser 2 client (rendering, input, interpolation, UI) + `build.mjs` (fingerprinted production build) |
| `lambda/` | `event-worker` (SQS → DynamoDB, idempotent) and `leaderboard-api` (ALB target) + shared store code |
| `tools/` | `local-cloud.mjs` (runs the real Lambda handlers locally) and `dev.mjs` (starts everything) |
| `infra/` | CloudFormation templates and deploy/evidence scripts. See [`infra/README.md`](infra/README.md) |
| `load-tests/` | Synthetic WebSocket players for load and scaling tests |
| `tests/` | Smoke test, CloudFront cache test, scaling watcher |
| `evidence/` | Captured outputs backing every report claim |

## Run locally

Requires Node.js 22+.

```bash
npm run install:all
npm run dev            # game server :8080 (serves the client) + local cloud emulator :8090
```

Open `http://localhost:8080` in two browsers (or one normal and one private window, since tabs in the
same browser share the anonymous player ID) and join within 10 s to share a world. The local
cloud emulator receives events over HTTP, runs the real `event-worker` handler against an
in-memory store, and serves `/api/leaderboard`.

Useful environment variables (`server/src/config.js`): `LOBBY_MS` (10000), `MAX_HUMANS` (4),
`TOTAL_SNAKES` (50), `TICK_RATE` (30), `SNAPSHOT_RATE` (15), `WORLD_RADIUS` (2400),
`EVENT_SINK` (`log` | `http` | `sqs`).

## Tests

```bash
npm test                                   # 37 server tests (unit + WebSocket integration) + 13 Lambda tests
tests/smoke.sh https://<distribution>.cloudfront.net
tests/cache-test.sh https://<distribution>.cloudfront.net 5
```

## Docker

```bash
docker build -t n5528712-a3-game server
docker run --rm -p 8080:8080 --cpus 0.25 --memory 512m -e EVENT_SINK=log n5528712-a3-game
curl localhost:8080/health
```

The image is `node:22-alpine`, runs as the non-root `node` user, has a `HEALTHCHECK`, and takes
all configuration from environment variables (no credentials inside).

## Deploy to AWS

```bash
aws sso login
AWS_PROFILE=default infra/scripts/deploy.sh
```

See [`infra/README.md`](infra/README.md) for the step order and the account-policy workarounds
(no IAM role/SG/certificate creation, no bucket/log-group deletion for the student role).

## Load testing / scaling demo

```bash
tests/watch-scaling.sh 30 &                                   # desired/running tasks, occupancy, CPU
node load-tests/websocket-load.js --url wss://<distribution>.cloudfront.net/ws \
     --clients 14 --duration 1500 --ramp 30
```

Each virtual player joins, retries `ROOM_FULL` (fast jitter, then backoff while capacity is added),
plays with plausible input, respawns and measures RTT. The summary includes how players were
distributed across tasks.

## Evidence

`infra/scripts/collect-evidence.sh` snapshots inventory, scaling activities, target health,
CloudWatch metric exports, queue depths and the leaderboard into `evidence/aws/`. See
[`docs/evidence-register.md`](docs/evidence-register.md) and
[`evidence/screenshots-needed.md`](evidence/screenshots-needed.md).

## Cleanup

See [`infra/CLEANUP.md`](infra/CLEANUP.md). Nothing is torn down automatically.

## Attribution

Original game code and assets: Loonride, *How to make Slither.io with JavaScript* (2017),
https://github.com/Loonride/slither.io-clone. Phaser CE 2.6.2 © Photon Storm Ltd (MIT).
