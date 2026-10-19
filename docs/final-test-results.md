# Final acceptance test results

Run on 2026-10-19 against the deployed system (`https://d3riy98bj197ur.cloudfront.net/`) and the repository at
the commit noted in each evidence file. PASS = requirement met with evidence; PARTIAL = met with a stated
limitation; FAIL = not met.

## Functional requirements

| ID | Requirement | Result | Evidence |
|----|-------------|--------|----------|
| F1 | Anonymous display name (sanitised, ≤16 chars) and join | **PASS** | protocol tests; deployed join (E3) |
| F2 | Steer with mouse/arrow keys, boost with SPACE/click | **PASS** | client; local browser test |
| F3 | Eat food and grow (+1 section, ×1.01 scale) | **PASS** | `snake.test.js`, `world.test.js` |
| F4 | Death on head-edge contact with another body or the arena edge; body becomes food | **PASS** | `world.test.js` (collision, boundary, food drop) |
| F5 | Dead human sees score and respawns (3 s or on request) | **PASS** | `room.test.js` respawn test; death screen in browser |
| F6 | 50 snake slots, ≤4 humans, NPCs = 50 − humans | **PASS** | `room.test.js` (1→49 … 4→46); deployed `/status` entities 50 |
| F7 | Lobby ≤10 s; starts immediately with 4 humans | **PASS** | `room.test.js`, integration test; WORLD_STARTED `lobbyWaitMs` |
| F8 | Late join replaces an NPC; 5th human gets ROOM_FULL and is routed elsewhere | **PASS** | unit + integration tests; load test: ROOM_FULL clients joined new tasks (E11/E14) |
| F9 | Score, in-world top 10 and global top 10 visible | **PASS** | browser UI; `/api/leaderboard` (E9) |
| F10 | Connection status; bounded jittered reconnect | **PASS** | task-failure test: 4 players rejoined other worlds within one 5 s sample (E16) |
| F11 | Durable results feed a global leaderboard | **PASS** | SQS → Lambda → DynamoDB logs and items (E7–E9) |
| F12 | Multiple real browsers share a world | **PASS** | local two-browser test (E1); deployed screenshots pending (S1) |

## Cloud / non-functional requirements

| Requirement | Result | Evidence |
|-------------|--------|----------|
| CloudFront serves the frontend from private S3 | **PASS** | E2 (direct S3 403) |
| Cache hit demonstrated | **PASS** | E6: asset Hit, Age 41→45; API Miss 615 ms → Hit ~20 ms; BNE50 |
| ECS/Fargate hosts the game server | **PASS** | E10, E12 |
| ALB distributes connections | **PASS** | E14: 14 players distributed 4/4/4/2 across tasks; E13 healthy targets in 3 AZs |
| ECS Service Auto Scaling works, with real scale-out evidence | **PASS** | E11: desired 1→2→3→4→5 (12:10:15 → 12:17:15 AEST) under synthetic gameplay load |
| Scale-in after load | **PASS** | E11b: 5→4→3→2→1 between 12:47 and 12:59 AEST, after 15 min below target |
| Scale-in protection for active worlds | **PASS** | E12-task-scale-in-protection.txt: 4 active tasks protected, idle task not |
| SQS async processing, Lambda consumer, DynamoDB storage | **PASS** | E7, E8, E9 |
| Retries / DLQ | **PASS** | E16-dlq-test.txt: 3 receives 60 s apart → DLQ → alarm |
| Idempotent consumer | **PASS** | `lambda/test/worker.test.mjs`, `dynamoStore.test.mjs` |
| Reconnect after server loss; ECS replaces the task | **PASS** | E16-task-failure-test.txt |
| Graceful shutdown flushes events | **PASS** | E16: 206 published, 0 dropped on SIGTERM |
| CloudWatch evidence (metrics, logs, dashboard, alarms) | **PASS** | E15 exports; dashboard `n5528712-a3` |
| Automated tests | **PASS** | 37 server + 13 Lambda tests (E18) |
| Load test tool works | **PASS** | E14 |
| Infrastructure reproducible | **PARTIAL** | 4 CloudFormation stacks + idempotent scripts. Buckets, log groups and Lambdas are created by scripts because of account deny policies (documented) |
| Required tags on taggable resources | **PASS** | `describe-stack.sh` inventory: all A3 stacks, ECS, ALB, Lambda, SQS, DynamoDB, ECR, S3, logs, alarms, secret, parameter, scalable target + CloudFront distribution carry `purpose=assessment 3` and `qut-username`. Non-taggable: OAC, cache policy, dashboard, bucket policy |
| Security: validation, rate limiting, no client trust | **PASS** | protocol/integration tests |
| Security: private origin | **PARTIAL** | ALB secret header + private tasks verified (E19). The SG can't be restricted and the origin hop is HTTP (no SG/ACM permissions) |
| Least-privilege IAM | **PARTIAL** | pre-provisioned roles only (iam:CreateRole denied); policies not inspectable |
| Log retention ≤7 days | **FAIL (account)** | `logs:PutRetentionPolicy` denied to the student role; retention left at default |

## Definition of done (from the project brief)

| Item | Status | Note |
|------|--------|------|
| original gameplay assets reused appropriately | ✅ | all 7 PNGs, Phaser CE 2.6.2, original constants/rules (docs/current-state.md §4) |
| authoritative server works | ✅ | 37 server tests; deployed |
| two real clients can play together | ✅ | E1 (local, two browsers), E3/E14 (deployed). Deployed two-window screenshot: S1 |
| maximum normal humans/world = 4 | ✅ | ROOM_FULL tests; load test 4/4/4/2 |
| world reaches 50 total entities using NPC fill | ✅ | tests + `/status` |
| lobby wait is never longer than 10 seconds | ✅ | tests; `lobbyWaitMs` ≤ 10,033 |
| CloudFront serves frontend | ✅ | E2 |
| cache HIT can be demonstrated | ✅ | E6 |
| ECS/Fargate hosts game server | ✅ | E10/E12 |
| ALB distributes connections | ✅ | E13/E14 |
| ECS Service Auto Scaling works | ✅ | E11 |
| real scale-out evidence exists | ✅ | E11 timeline + scaling activities + charts |
| SQS async processing works | ✅ | E7 |
| Lambda consumes events | ✅ | E8 |
| DynamoDB stores results | ✅ | E9 |
| leaderboard works | ✅ | `/api/leaderboard` + UI |
| reconnect behaviour works | ✅ | E16 |
| CloudWatch evidence exists | ✅ | E15, dashboard |
| automated tests pass | ✅ | 50/50 |
| load test works | ✅ | E14 |
| infrastructure is reproducible | ⚠️ PARTIAL | CloudFormation + scripts; some resources by script due to account denies |
| required AWS resources are correctly tagged | ✅ | inventory |
| submission YAML contains real deployed resources | ✅ | `submission/submission-infra.yml` (generated from live ARNs, YAML-validated) |
| vendor-neutral architecture diagram exists | ✅ | `report/figures/vendor-neutral.svg` |
| AWS architecture diagram exists | ✅ | `report/figures/aws-architecture.svg` |
| AWS Pricing Calculator inputs are prepared | ✅ | `docs/cost-estimate.md` (public link must be created by the student) |
| evidence register is complete | ✅ | `docs/evidence-register.md` (console screenshots listed in `evidence/screenshots-needed.md`) |
| demo plan is complete | ✅ | `docs/demo-video-plan.md` |
| report describes the actual deployed system | ✅ | `report/` |
| report does not invent evidence | ✅ | every figure traced to `evidence/` |
| AI declaration is truthful and awaiting user review | ⏳ | marked ⟦STUDENT TO REVIEW⟧ on the title page |
