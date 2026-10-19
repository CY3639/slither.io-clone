# Screenshots to capture (AWS console / browser)

Text evidence in `evidence/` was captured by script. These views need a human screenshot because
they are console pages or visual gameplay. Save them as `evidence/screenshots/<ID>-<name>.png`.
Region: **Asia Pacific (Sydney) ap-southeast-2**, signed in to account 901444280953.

| # | Evidence | Where | What must be visible | Why |
|---|----------|-------|----------------------|-----|
| S1 | E2/E3 | Browser: `https://d3riy98bj197ur.cloudfront.net/` in a normal and a private window, side by side | Both snakes in one world; HUD "task … · world …" identical in both; "This world" leaderboard with both names (blue = human) | Two real clients share an authoritative world |
| S2 | E5 | Browser, just after clicking Play | "Waiting for players" with countdown ≤ 10 s and the joined names | Lobby behaviour |
| S3 | E11 | CloudWatch → Dashboards → `n5528712-a3` (time range covering the load test, around 02:07–02:40 UTC / 12:07–12:40 AEST on 2026-10-19) | "ECS tasks: desired vs running" stepping up; "World occupancy %" above the 75 line; CPU widget | Genuine ECS Service Auto Scaling under load |
| S4 | E11 | ECS → Clusters → `n5528712-a3-cluster` → Services → `n5528712-a3-game` → **Events** tab | "has started N tasks" lines and Application Auto Scaling messages | Scale-out actions |
| S5 | E12 | Same service → **Tasks** tab | Several RUNNING tasks with different task IDs / AZs | Multiple worlds |
| S6 | E11 | ECS service → **Service auto scaling** tab (or Application Auto Scaling activity) | Two target-tracking policies (occupancy 75, CPU 50), min 1 / max 6 | Configuration |
| S7 | E13 | EC2 → Target groups → `n5528712-a3-game-tg` → Targets | Multiple **healthy** targets in different AZs | ALB distribution |
| S8 | E7 | SQS → `n5528712-a3-events` → Monitoring | Messages sent / deleted graphs | Async communication |
| S9 | E16 | SQS → `n5528712-a3-events-dlq` → Send and receive messages → Poll | The poison test message (`eventId: not-a-uuid`), receive count | DLQ after 3 attempts |
| S10 | E8 | CloudWatch → Log groups → `/aws/lambda/n5528712-a3-event-worker` | `event_processed` lines with eventId, `result: applied`, and an `event_malformed` line | Lambda consumer + validation |
| S11 | E9 | DynamoDB → Tables → `n5528712-a3-game` → Explore items → Query index `GSI1`, `GSI1PK = LB`, descending | Ranked best scores | Structured persistence, no scan |
| S12 | E6 | Browser DevTools → Network on the app, reload twice | `x-cache: Hit from cloudfront` on `app.<hash>.js` and `asset/*.png` | Edge caching (complements `E6-cache-test.txt`) |
| S13 | E15 | CloudFront → Distributions → `d3riy98bj197ur…` → Monitoring | Requests and **Cache hit rate** | Edge caching at scale |
| S14 | Tags | Resource Groups & Tag Editor → search tag `purpose = assessment 3` | List of A3 resources | Tagging requirement |
| S15 | Cost | AWS Pricing Calculator (public estimate link) | Inputs from `docs/cost-estimate.md` | Cost section |
