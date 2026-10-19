# Requirements

## Functional requirements

| ID | Requirement |
|----|-------------|
| F1 | A player enters an anonymous display name (1–16 characters, sanitised) and joins a multiplayer world. |
| F2 | The player steers a snake with the mouse (or arrow keys) and boosts with SPACE or the left mouse button. |
| F3 | Snakes eat food and grow (one section and ×1.01 scale per food, as in the original game). |
| F4 | A snake whose head front touches another snake's body, or the arena boundary, dies. Its body becomes food. |
| F5 | A dead human sees their score and respawns (automatically after 3 s, or immediately on request). |
| F6 | Each world holds exactly 50 snake slots once started: ≤ 4 humans, and NPCs fill the rest (`NPCs = 50 − humans`). |
| F7 | The first human to join an idle world opens a lobby that lasts at most 10 s. It starts early when 4 humans are present. |
| F8 | A human joining a running world with < 4 humans replaces an NPC immediately. A 5th human gets `ROOM_FULL` and the client retries with jitter so the load balancer can route it to another world. |
| F9 | Score (current length gained) and an in-world top-10 leaderboard are visible in game. A persistent global top-10 is visible on the join screen and in game. |
| F10 | Connection status is visible. When the connection drops, the client shows "reconnecting", backs off with jitter (bounded attempts), and joins any available world. |
| F11 | Deaths and session results are stored durably and feed the global leaderboard. |
| F12 | Multiple real browser clients share one authoritative world. |

## Non-functional requirements

| Quality | Requirement | Measure / target |
|---------|-------------|------------------|
| Scalability | Capacity grows horizontally by adding independent worlds (one per container task). No shared realtime state between worlds. | `worlds = ceil(concurrentHumans / 4)` plus headroom. Scale-out is triggered automatically by ECS Service Auto Scaling. |
| Latency | Server-authoritative simulation at 30 ticks/s, snapshots at 15 Hz, client interpolation (~100 ms buffer). | WebSocket RTT p95 < 150 ms from Brisbane. Server tick duration p95 < 10 ms. |
| Reliability | Losing a task only loses that world's transient state. Durable results survive in DynamoDB. Async events are retried, and poison messages go to a DLQ. | SQS maxReceiveCount = 3 → DLQ. Idempotent consumer. Client reconnect within ~1–5 s. |
| Availability | Load balancer health checks plus ECS replacement of failed tasks. Tasks spread across ≥ 2 AZs. | Unhealthy tasks are replaced automatically. |
| Security | Server never trusts client position, score, collision or growth. Messages are schema-validated, size-capped and rate-limited. HTTPS/WSS only at the edge. Storage not public. IAM roles, no static keys. | Malformed or oversized inputs are rejected (tested). The S3 bucket is reachable only via CloudFront OAC. The ALB accepts only CloudFront. |
| Maintainability | Small modules, configuration by environment variables, IaC templates, automated unit/integration tests. | `npm test` passes. All infrastructure is reproducible from `infra/`. |
| Cost | Pay for capacity in proportion to demand: small ARM Fargate tasks with autoscaling (min 1), serverless async path, on-demand DynamoDB, CloudFront for static delivery, no NAT gateway, 7-day log retention. | Estimated monthly cost documented with AWS Pricing Calculator inputs. |
| Sustainability | Idle worlds stop simulating. Scale-in removes idle capacity. Graviton (arm64) tasks. Edge caching avoids repeat origin work. | Idle task CPU ≈ 0–1 %. Observed cache hit ratio. |
| Observability | Structured JSON logs with `worldId`, `taskId`, `playerId`, event type. Custom metrics (humans, occupancy, tick time). CloudWatch dashboard and alarms. | Dashboard shows scaling, CPU, queue and Lambda metrics. |

## Constraints

* AWS region `ap-southeast-2`. Resources named `n5528712-a3-*` and tagged `purpose=assessment 3`, `qut-username=n5528712@qut.edu.au`.
* Scaling evidence must come from **non-Lambda** auto-scaling (ECS Service Auto Scaling).
* Single developer, limited budget: the simplest defensible design wins.

## Out of scope (deliberate)

Accounts/Cognito, cosmetics, chat, matchmaking beyond "join any world", cross-world synchronisation, restoring a lost world's in-memory state.
