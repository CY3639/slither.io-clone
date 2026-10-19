# AWS architecture

> Status: **as deployed on 2026-10-19.** The Phase 1 baseline was revised where the CAB432 account's deny policies
> required it (see `docs/current-state.md` §7 and the "Deviations" table below). Live identifiers:
> CloudFront `d3riy98bj197ur.cloudfront.net`, ALB `n5528712-a3-alb`, cluster `n5528712-a3-cluster`,
> service `n5528712-a3-game`, queue `n5528712-a3-events`, table `n5528712-a3-game`.

## Deviations from the Phase 1 baseline (forced by account policy)

| Baseline | Deployed | Reason |
|----------|----------|--------|
| ALB HTTPS listener with ACM cert for an origin hostname | HTTP listener; CloudFront origin `http-only` | `acm:RequestCertificate` explicitly denied |
| ALB SG ingress only from the CloudFront prefix list; task SG only from ALB SG | Shared `CAB432SG` for both; tasks in **private subnets without public IP**; ALB forwards only with the secret header | `ec2:CreateSecurityGroup` explicitly denied |
| Tasks in public subnets with public IP (no NAT cost) | Tasks in private subnets using the account's existing NAT | Needed to keep tasks unreachable with the shared SG |
| Purpose-built least-privilege IAM roles | Pre-provisioned `Execution-Role-CAB432-ECS`, `Task-Role-CAB432-ECS`, `CAB432-Lambda-Role` | `iam:CreateRole` explicitly denied |
| Lambdas and ESM in CloudFormation | Created by `infra/scripts/deploy-lambdas.sh` | CloudFormation Lambda handler blocked by the `lambda:GetFunction` deny |
| Buckets / log groups in CloudFormation, 7-day retention | Created by script; default retention | `s3:DeleteBucket`, `logs:DeleteLogGroup`, `logs:PutRetentionPolicy` denied |
| Secret injected via task-definition `secrets` (execution role) | Read at start-up by the task role via the SDK | Execution-role permissions not inspectable; task-role access proven by A2 |

## Service mapping

| Vendor-neutral concept | AWS service | Configuration (planned) |
|------------------------|-------------|-------------------------|
| Edge cache / CDN | **CloudFront** | One distribution. Default behaviour → S3 (OAC, `CachingOptimized`). `/ws` → ALB (`CachingDisabled`, all viewer headers except Host). `/api/*` → ALB (custom cache policy, 10 s default TTL, query string `limit`/`id` in key). HTTPS only (redirect HTTP). Price class 200 (includes Australia, excludes the most expensive edges). |
| Object storage | **S3** | Private bucket `n5528712-a3-frontend-<acct>`, Block Public Access on, bucket policy allows only the distribution via OAC. Objects uploaded with `Cache-Control: public,max-age=31536000,immutable` (fingerprinted) or `no-cache` (`index.html`). |
| Load balancer | **Application Load Balancer** | Internet-facing, ≥ 2 AZs. Listener rules: `/ws` and `/health` → ECS target group; `/api/*` → Lambda target group. Requests without the CloudFront secret header get a fixed 403. (Planned SG restricted to the CloudFront prefix list was not possible; see Deviations.) Idle timeout 120 s. Deregistration delay 15 s. Deployed: HTTP listener + secret header (ACM denied). |
| Game workers | **ECS on Fargate** (arm64/Graviton) | Service `n5528712-a3-game`, task 0.25 vCPU / 0.5 GB (tuned by measurement), container port 8080, `awslogs` driver, container health check on `/health`, `stopTimeout` 30 s. Private subnets, no public IP (see Deviations). |
| Container registry | **ECR** | `a3/n5528712-game`, scan on push, lifecycle policy keeps the last 10 images. |
| Autoscaler | **Application Auto Scaling (ECS Service Auto Scaling)** | Min 1, max 6. Target tracking #1: `WorldOccupancyPct` (custom EMF metric, Average) target 75. Target tracking #2: `ECSServiceAverageCPUUtilization` target tuned from measurement (start 40). Scale-out cooldown 60 s, scale-in 180 s. Workers with humans call the ECS agent **task scale-in protection** endpoint. |
| Message queue + DLQ | **SQS** standard | `n5528712-a3-events` (visibility 60 s, retention 4 d, long polling 20 s), redrive to `n5528712-a3-events-dlq` after `maxReceiveCount = 3` (DLQ retention 14 d). |
| Async worker | **Lambda** (Node.js 22, arm64) | `n5528712-a3-event-worker`, 256 MB, timeout 10 s, SQS event source mapping batch 10 / window 2 s, `ReportBatchItemFailures`, max concurrency 2. |
| Read API | **Lambda** behind ALB | `n5528712-a3-leaderboard-api`, 128 MB. Returns `Cache-Control: public, max-age=10`. |
| Structured store | **DynamoDB** on-demand | Single table `n5528712-a3-game` (PK/SK) + GSI `GSI1` (GSI1PK S, GSI1SK N), TTL attribute `ttl`. |
| Configuration / secrets | **Secrets Manager + SSM Parameter Store** | Session-token signing secret in Secrets Manager (read by the task at start-up). CloudFront→ALB header value in SSM SecureString. Non-secret configuration via task definition environment variables. |
| Monitoring | **CloudWatch** | Log groups (retention can't be set by the student role), EMF custom metrics in namespace `n5528712/A3Game`, dashboard `n5528712-a3`, 5 alarms (DLQ not empty, worker errors, queue backlog, unhealthy targets, slow tick), Container Insights, CloudFront additional metrics. |
| Identity | **IAM** | Pre-provisioned CAB432 roles (see Deviations). Verified capabilities: task role can SQS SendMessageBatch, read the secret, set task protection; Lambda role can consume SQS and read/write DynamoDB. |
| IaC | **CloudFormation** + AWS CLI scripts | Stacks `data`, `backend`, `frontend`, `monitoring`, plus idempotent scripts for buckets, log groups, Lambdas and the origin secret. |

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

* Fargate tasks run in **private subnets without public IPs** and reach ECR, SQS and Secrets Manager through the
  account's pre-existing NAT gateways (not provisioned or paid for by this project's stacks). The original plan was
  public subnets with public IPs to avoid NAT, but with the shared SG open on 8080 that would expose the game port.
* The ALB is the main fixed cost (≈ US$ 0.0252/h + LCU). It is shared by the WebSocket and API paths.
* CloudFront price class and the S3 static origin keep static delivery off the containers entirely.
