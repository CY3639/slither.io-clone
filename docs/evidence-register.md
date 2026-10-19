# Evidence register

Every report claim maps to an item here. Files are under `evidence/`. Times are UTC (Brisbane = UTC+10).
"Screenshot" items are listed in `evidence/screenshots-needed.md` for the student to capture.
Status: ✅ captured · ⏳ pending capture · 📸 needs a console screenshot.

| ID | What it proves | Command / test | When (UTC) | AWS resource | Result | Screenshot? | Report § | Video |
|----|----------------|----------------|------------|--------------|--------|-------------|----------|-------|
| E1 | Local multiplayer: two real browser clients share one authoritative world | `npm run dev`, two browser tabs, `GET /status`. Integration test `server/test/integration.test.js` | 2026-10-19 01:01 | local | ✅ `/status`: `humans 2, npcs 48, worldId Maclan-1`. Both tabs on `world Maclan-1`. Integration test: both clients get the same `worldId`, 50 entities | Optional | §4 | — |
| E2 | Deployed frontend over CloudFront; S3 is private | `tests/smoke.sh`, `curl` direct S3 | 2026-10-19 02:01 | CloudFront `d3riy98bj197ur.cloudfront.net`, S3 `n5528712-a3-frontend-901444280953` | ✅ index 200 via CloudFront. Direct S3 URL **403** | 📸 app in browser | §3 | 0:00 |
| E3 | WebSocket multiplayer through CloudFront → ALB → ECS | `load-tests/websocket-load.js --clients 2` via `wss://…/ws` | 2026-10-19 02:01 | ALB `n5528712-a3-alb`, service `n5528712-a3-game` | ✅ 2/2 joined, RTT p50 19 ms / p95 61 ms, snapshot interval p50 67 ms | 📸 two windows | §4 | 0:30 |
| E4 | 50-entity world (humans + NPC fill) | unit tests `room.test.js` ("NPC fill is 50 − humans for 1..4 humans"); `/status` | 2026-10-19 | ECS task | ✅ 1→49, 2→48, 3→47, 4→46 NPCs (tests). Deployed `/status` entities 50 | — | §4 | 0:30 |
| E5 | Lobby ≤10 s; starts immediately at 4 humans; ROOM_FULL for the 5th | unit tests + integration test; deployed lobby | 2026-10-19 | ECS task | ✅ starts by 10 s (timer) or instantly when full. 5th client: `ROOM_FULL`, close 4001 | 📸 lobby countdown | §4 | 0:15 |
| E6 | CloudFront cache MISS → HIT | `tests/cache-test.sh … 5` → `evidence/aws/E6-cache-test.txt` | 2026-10-19 02:02 | CloudFront, POP BNE50 | ✅ asset Hit (Age 41→45 s, ~20 ms). API Miss 615 ms → Hit 18–31 ms. index.html RefreshHit (no-cache) | 📸 optional | §3, §5 | 1:20 |
| E7 | SQS carries game events; queue drains; DLQ catches poison messages | queue depths; `E16-dlq-test.txt` | 2026-10-19 02:02 / 02:08 | SQS `n5528712-a3-events`, `…-dlq` | ✅ events sent/deleted, depth 0. DLQ result: see E16 | 📸 SQS monitoring | §3, §4 | 2:00 |
| E8 | Lambda consumes events (idempotent, partial batch failures) | CloudWatch Logs `/aws/lambda/n5528712-a3-event-worker` | 2026-10-19 02:01 | Lambda `n5528712-a3-event-worker` | ✅ `event_processed` for PLAYER_DIED, WORLD_STARTED, WORLD_COMPLETED, SESSION_ENDED (`result: applied`) | 📸 log lines | §4 | 2:10 |
| E9 | DynamoDB stores results; leaderboard via GSI Query | `aws dynamodb query --index-name GSI1`; `/api/leaderboard` | 2026-10-19 02:02 | DynamoDB `n5528712-a3-game` | ✅ ranked items from GSI1 (no Scan). API serves the same | 📸 table items | §4 | 2:20 |
| E10 | Single-task baseline | `tests/watch-scaling.sh 1 1` → `E10-baseline-single-task.txt` | 2026-10-19 02:04 | ECS service | ✅ desired 1, running 1, occupancy 0 %, CPU 2.9 %, min 1 / max 6 | — | §3 | 2:35 |
| E11 | ECS Service Auto Scaling scale-out under load | load test 14 players + watcher → `E11-scaling-timeline.txt`, scaling activities | ⏳ | ECS + Application Auto Scaling | ⏳ | 📸 dashboard | §3, §4 | 3:00 |
| E12 | Multiple running tasks = multiple independent worlds | ECS service events, load-test task distribution | ⏳ | ECS | ⏳ | 📸 Tasks tab | §4 | 3:30 |
| E13 | ALB healthy targets across AZs | `describe-target-health` | ⏳ | target group `n5528712-a3-game-tg` | ⏳ | 📸 targets | §3 | 3:50 |
| E14 | Load-test results (connections, RTT, distribution) | `E14-load-test-scaleout.json/.log`; local `evidence/local/E14*` | ⏳ / 2026-10-19 | — | Local: 4 in world, 2 bounced (ROOM_FULL), RTT p50 1 ms. Delta encoding −41 % bytes | — | §4, §5 | 3:00 |
| E15 | CloudWatch metrics (CPU, memory, occupancy, tasks, Lambda, SQS, DynamoDB) | `collect-evidence.sh` → `E15-cloudwatch-metrics-*.csv`; dashboard | ⏳ | CloudWatch | ⏳ | 📸 dashboard | §3, §5 | throughout |
| E16 | Resilience: DLQ after 3 attempts; reconnect after task loss; ECS replacement | poison message; `aws ecs stop-task` during load | ⏳ | SQS DLQ, ECS | ⏳ | 📸 optional | §4 | 4:00 |
| E17 | Cost measurements (task size, utilisation, bandwidth per player) | CloudWatch CPU/memory; snapshot bytes; pricing inputs | ⏳ | — | ⏳ | — | §5 | — |
| E18 | Automated tests pass | `npm test` → `evidence/local/automated-tests.txt` | 2026-10-19 | — | ✅ 37 server + 13 Lambda tests pass | — | §4 | — |
| E19 | Security controls | ALB without header → 403; direct S3 → 403; tasks in private subnets with no public IP; input validation tests | 2026-10-19 01:57 | ALB, S3, ECS | ✅ | — | §3 | — |
