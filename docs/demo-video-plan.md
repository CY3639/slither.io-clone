# Demonstration video plan (≈4:45)

Demonstration first, little narration. Everything below is prepared in advance. Because
scale-out takes ~4–6 minutes in real time (3 one-minute alarm datapoints + task start), **start the
load test about 6 minutes before recording** and record the scaling segment once desired tasks are rising.
Keep the CloudWatch dashboard's time range at "1 h" so the earlier ramp is visible.

## Before recording (T−10 min)

```bash
export AWS_PROFILE=default
aws sso login                                                  # if the session expired
tests/smoke.sh https://d3riy98bj197ur.cloudfront.net            # all PASS
# T-6 min: start load and the watcher in two terminals
node load-tests/websocket-load.js --url wss://d3riy98bj197ur.cloudfront.net/ws --clients 14 --duration 1200 --ramp 20
tests/watch-scaling.sh 20
```

Open these tabs in order:

1. Chrome window A: `https://d3riy98bj197ur.cloudfront.net/`
2. Chrome **private** window B: same URL (separate anonymous identity)
3. CloudWatch dashboard `n5528712-a3`
4. ECS console → cluster `n5528712-a3-cluster` → service `n5528712-a3-game` → Tasks tab
5. EC2 console → Target groups → `n5528712-a3-game-tg` → Targets tab
6. SQS console `n5528712-a3-events` (Monitoring tab), DynamoDB `n5528712-a3-game` → Explore items
7. Terminal with `tests/cache-test.sh` ready to run

**Load-test caveat:** while synthetic players fill worlds, a human joining may get `ROOM_FULL` and wait
for a new task. For the gameplay segment, either record it before starting the load, or note the
task ID shown in the HUD.

## Script

| Time | Show | Say (short) |
|------|------|-------------|
| 0:00–0:30 | Window A: CloudFront URL, join screen with all-time leaderboard; type name, Play; lobby countdown | "Static client from S3 via CloudFront; joining opens a ≤10 s lobby." |
| 0:30–1:20 | Window B joins during the countdown, then both in the same world. HUD shows the same task/world ID. Move, boost (shadow lights up), eat, grow, die (death screen, killer), auto-respawn. World leaderboard lists both humans among NPCs. | "Server-authoritative world: 2 humans + 48 NPCs = 50 snakes; browsers send only heading/boost." |
| 1:20–1:55 | Terminal: `tests/cache-test.sh https://d3riy98bj197ur.cloudfront.net 4`: Miss → Hit with Age rising for the asset and API, BNE edge POP | "Fingerprinted assets cached a year at the Brisbane edge; leaderboard cached 10 s." |
| 1:55–2:35 | After a death: CloudWatch Logs `/aws/lambda/n5528712-a3-event-worker` showing `event_processed PLAYER_DIED` with the eventId; DynamoDB item `PLAYER#…/PROFILE` with bestScore; refresh the join screen leaderboard | "Death → SQS → Lambda → DynamoDB; idempotent by eventId; DLQ after 3 failures." |
| 2:35–3:50 | Terminal with the load test (ROOM_FULL retries, tasks{...} growing) and the watcher (desired 1→2→3→4). Dashboard: occupancy above the 75 line, desired/running task graph stepping up, CPU per task. ECS console Tasks tab listing several RUNNING tasks. | "Each task is one world of 4 humans. Occupancy target tracking adds worlds; ROOM_FULL clients are routed to new tasks." |
| 3:50–4:30 | Target group: several healthy targets in different AZs. Window A still playing smoothly. Optional: ECS console → stop one task → client shows "reconnecting" and lands in another world, ECS starts a replacement. | "ALB spreads new connections; a lost world costs one life, not the stats." |
| 4:30–4:50 | Dashboard overview (SQS, Lambda, DynamoDB widgets); evidence folder | "All claims in the report map to evidence/." |

## Fallbacks

* If scale-out is still at 1 task when recording starts, show the previous run's recorded
  timeline (`evidence/aws/E11-scaling-timeline.txt`) and the dashboard's past 1–2 h.
* If an SSO session expires mid-recording, the deployed app keeps working; only the terminal
  commands need `aws sso login`.
