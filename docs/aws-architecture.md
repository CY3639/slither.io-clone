# AWS architecture

> Status: design baseline (Phase 1). Sections marked **[verify]** are confirmed or revised against the real account
> before provisioning, and the deployed values are recorded in `docs/final-test-results.md` and `evidence/`.

## Service mapping

| Vendor-neutral concept | AWS service | Configuration (planned) |
|------------------------|-------------|-------------------------|
| Edge cache / CDN | **CloudFront** | One distribution. Default behaviour → S3 (OAC, `CachingOptimized`). `/ws` → ALB (`CachingDisabled`, all viewer headers except Host). `/api/*` → ALB (custom cache policy, 10 s default TTL, query string `limit`/`id` in key). HTTPS only (redirect HTTP). Price class 200 (includes Australia, excludes the most expensive edges). |
| Object storage | **S3** | Private bucket `n5528712-a3-frontend-<acct>`, Block Public Access on, bucket policy allows only the distribution via OAC. Objects uploaded with `Cache-Control: public,max-age=31536000,immutable` (fingerprinted) or `no-cache` (`index.html`). |
| Load balancer | **Application Load Balancer** | Internet-facing, ≥ 2 AZs. Listener rules: `/ws` and `/health` → ECS target group; `/api/*` → Lambda target group. Requests without the CloudFront secret header get a fixed 403. SG ingress only from the CloudFront origin-facing managed prefix list. Idle timeout 120 s. Deregistration delay 15 s. **[verify] HTTPS listener with ACM certificate for `n5528712-a3.cab432.com`, otherwise HTTP origin + secret header.** |
| Game workers | **ECS on Fargate** (arm64/Graviton) | Service `n5528712-a3-game`, task 0.25 vCPU / 0.5 GB (tuned by measurement), container port 8080, `awslogs` driver, container health check on `/health`, `stopTimeout` 30 s. Public subnets with public IP (no NAT gateway, see cost). Task SG ingress only from the ALB SG. |
| Container registry | **ECR** | `a3/n5528712-game`, scan on push, lifecycle policy keeps the last 10 images. |
| Autoscaler | **Application Auto Scaling (ECS Service Auto Scaling)** | Min 1, max 6. Target tracking #1: `WorldOccupancyPct` (custom EMF metric, Average) target 75. Target tracking #2: `ECSServiceAverageCPUUtilization` target tuned from measurement (start 40). Scale-out cooldown 60 s, scale-in 180 s. Workers with humans call the ECS agent **task scale-in protection** endpoint. |
| Message queue + DLQ | **SQS** standard | `n5528712-a3-events` (visibility 60 s, retention 4 d, long polling 20 s), redrive to `n5528712-a3-events-dlq` after `maxReceiveCount = 3` (DLQ retention 14 d). |
| Async worker | **Lambda** (Node.js 22, arm64) | `n5528712-a3-event-worker`, 256 MB, timeout 10 s, SQS event source mapping batch 10 / window 2 s, `ReportBatchItemFailures`, max concurrency 2. |
| Read API | **Lambda** behind ALB | `n5528712-a3-leaderboard-api`, 128 MB. Returns `Cache-Control: public, max-age=10`. |
| Structured store | **DynamoDB** on-demand | Single table `n5528712-a3-game` (PK/SK) + GSI `GSI1` (GSI1PK S, GSI1SK N), TTL attribute `ttl`. |
| Configuration / secrets | **SSM Parameter Store** | Session-token signing secret (SecureString) injected into ECS through `secrets`. Non-secret configuration via task definition environment variables. |
| Monitoring | **CloudWatch** | Log groups (7-day retention), EMF custom metrics in namespace `n5528712/A3Game`, dashboard `n5528712-a3`, alarms (DLQ depth > 0, Lambda errors, unhealthy targets, high tick time). |
| Identity | **IAM** | ECS task execution role (ECR pull, logs, SSM read), ECS task role (SQS send, task protection), Lambda roles (SQS consume, DynamoDB R/W on one table). **[verify] whether the student role can create roles, or pre-provisioned roles must be used.** |
| IaC | **CloudFormation** + AWS CLI scripts | Stacks: `network` (SGs; reuses the account VPC), `data`, `backend`, `frontend`, `monitoring`. **[verify] CloudFormation permissions.** |

## Request paths

```
Browser ──HTTPS──► CloudFront ──(OAC)──► S3            index.html, app.<hash>.js, asset/*.<hash>.png
Browser ──WSS────► CloudFront ──► ALB ──► ECS task     /ws   (one TCP connection pinned to one task)
Browser ──HTTPS──► CloudFront ──► ALB ──► Lambda       /api/leaderboard (edge cached 10 s)
ECS task ──SendMessageBatch──► SQS ──ESM──► Lambda ──TransactWriteItems──► DynamoDB
ECS task ──stdout (JSON + EMF)──► CloudWatch Logs ──► CloudWatch Metrics ──► Application Auto Scaling
```

## DynamoDB single-table design

| Entity | PK | SK | Attributes | Notes |
|--------|----|----|------------|-------|
| Player profile | `PLAYER#<playerId>` | `PROFILE` | `displayName, bestScore, deaths, kills, sessions, playMs, updatedAt, GSI1PK='LB', GSI1SK=bestScore` | GSI attributes only written once bestScore > 0 (sparse index). |
| Death record | `PLAYER#<playerId>` | `DEATH#<isoTime>#<eventId>` | `score, length, kills, worldId, killedBy, survivedMs` | Per-player history (query by PK, SK prefix). |
| World record | `WORLD#<worldId>` | `META` | `taskId, startedAt, completedAt, peakHumans, humanDeaths, durationMs` | Written from WORLD_STARTED / WORLD_COMPLETED. |
| Idempotency marker | `EVENT#<eventId>` | `EVENT` | `type, processedAt, ttl (now + 7 d)` | `attribute_not_exists(PK)` condition inside the same transaction as the aggregate update. |

Access patterns:

1. Global top-N leaderboard → `Query GSI1 WHERE GSI1PK='LB'`, `ScanIndexForward=false`, `Limit=N` (no scan).
2. A player's profile → `GetItem PLAYER#id / PROFILE`.
3. A player's recent deaths → `Query PK=PLAYER#id AND begins_with(SK,'DEATH#')`.
4. World summary → `GetItem WORLD#id / META`.

`GSI1PK='LB'` is a single partition. At this scale (≪ 1000 writes/s) that is fine. Past that, write-shard the key
(`LB#0..N`) and merge N queries. This trade-off is recorded for the report.

## Networking and cost choices

* Fargate tasks run in **public subnets with public IPs**, so no NAT gateway is needed (≈ US$ 0.059/h + data processing per AZ).
  The task security group only accepts traffic from the ALB security group, so the public IP does not expose the game port.
* The ALB is the main fixed cost (≈ US$ 0.0252/h + LCU). It is shared by the WebSocket and API paths.
* CloudFront price class and the S3 static origin keep static delivery off the containers entirely.
