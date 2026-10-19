# Cost estimate and AWS Pricing Calculator inputs

All unit prices are **on-demand, ap-southeast-2 (Sydney) / CloudFront Australia**. They were read from the
public AWS Price List files (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/…`)
on 2026-10-19; the Price List API itself is denied to the student role. Free tier is ignored.

## Measured inputs (from this deployment)

| Quantity | Measured value | Source |
|----------|----------------|--------|
| Task size | 0.25 vCPU, 0.5 GB, Linux/ARM64 | `backend.yml` |
| CPU of an **active** world (4 players + 46 NPCs) on Fargate Graviton | ≈ 22–29 % of 0.25 vCPU | CloudWatch `AWS/ECS CPUUtilization` during E11 |
| CPU of an **idle** task (no world) | ≈ 3 % | E10 |
| Memory of a task | ≈ 25 MB used of 512 MB | local `docker stats` (E14), CloudWatch MemoryUtilization |
| Snapshot egress per player, before optimisation (full-resolution JSON, uncompressed), 25-min AWS run | ≈ 100–111 KiB/s ≈ 0.37 GB/player-hour | `E17-server-snapshot-bytes-uncompressed.txt` |
| Snapshot egress per player, **deployed** (half-resolution, delta-encoded, permessage-deflate), measured on the wire through CloudFront, 4 players × 10 min | **≈ 21.2 KiB/s ≈ 0.078 GB/player-hour** (156.2 MiB payload → 48.9 MiB on the wire, −69 % from compression alone) | `E17-deployed-bandwidth-4players.json` |
| Events per player-hour | ≈ 360 `PLAYER_DIED` + 1 `SESSION_ENDED` (synthetic players die every ~10 s; real players far less) | worker logs |
| Lambda worker duration | tens of ms per batch, 256 MB, arm64 | CloudWatch Lambda Duration |

## Unit prices used

| Item | Price |
|------|-------|
| Fargate ARM vCPU-hour / GB-hour | $0.03885 / $0.00426 → **$0.011843 per 0.25 vCPU + 0.5 GB task-hour** |
| ALB hour / LCU-hour | $0.0252 / $0.008 |
| CloudFront data transfer out, Australia (first 10 TB) | $0.114 per GB |
| CloudFront HTTPS requests | negligible here (static assets cached by browsers for a year; one WebSocket per session) |
| Lambda ARM requests / GB-second | $0.20 per million / $0.0000133334 |
| SQS standard requests | $0.40 per million |
| DynamoDB on-demand WRU / RRU / storage | $0.71 per million / $0.1425 per million / $0.285 per GB-month (beyond 25 GB) |
| CloudWatch custom metric / alarm / log ingest / log storage | $0.30 per metric-month / $0.10 per alarm-month / $0.67 per GB / $0.033 per GB-month |
| ECR storage | $0.10 per GB-month |
| Secrets Manager | $0.40 per secret-month |

## Capacity model

Each task hosts one world with at most **4 humans**; NPCs are workload, not users.

```
requiredWorlds = ceil(concurrentHumans / 4)
runningTasks   ≈ ceil(concurrentHumans / (4 × 0.75))   # occupancy target 75 % keeps ~25 % empty seats
```

The 25 % headroom is what lets a new player join immediately instead of waiting ~4 minutes for a scale-out.

## Scenario

The assignment doesn't fix a demand figure, so this estimate assumes a modest public game:
**average 60 concurrent humans, peak 200**, 24×7 (730 h/month).

| Component | Calculation | Monthly (USD) |
|-----------|-------------|---------------|
| Fargate | average 60 humans → 20 tasks × $0.011843 × 730 | **$172.9** |
| ALB fixed | $0.0252 × 730 | $18.4 |
| ALB LCU (processed bytes dominate; 1 LCU = 1 GB/h) | 60 × 0.078 GB/h = 4.7 GB/h → 4.7 LCU × $0.008 × 730 | $27.4 |
| CloudFront egress (deployed encoding) | 60 × 0.078 GB × 730 h = 3,416 GB × $0.114 | **$389.4** |
| *(CloudFront egress before optimisation)* | *60 × 0.37 GB × 730 = 16,206 GB × $0.114 (first 10 TB) / $0.098 (next)* | *≈ $1,750* |
| SQS | ~60 × 30 events/h × 730 × (send + receive + delete, batched by 10) ≈ 1.3 M requests | $0.5 |
| Lambda worker | ~0.2 M invocations, ~0.05 s × 0.25 GB each | < $1 |
| Leaderboard API Lambda | edge-cached 10 s → at most ~0.3 M origin calls/month | < $1 |
| DynamoDB | ~1.3 M events × ~5 WRU (transaction = 2× + marker + max update) ≈ 6.5 M WRU + small RRU | $4.7 |
| CloudWatch | 11 custom metrics ($3.3) + 5 alarms + target-tracking alarms (~4) ($0.9) + logs ~10 GB ingest ($6.7) + Container Insights metrics (~10 metrics, $3) | ~$14 |
| ECR, Secrets Manager, S3 (static site, < 1 MB) | 0.3 GB × $0.10 + $0.40 + cents | ~$0.5 |
| **Total (average load, deployed encoding)** | | **≈ $630 / month** (≈ $0.014 per player-hour) |

Observations for the report:

* **Bandwidth, not compute, dominates.** Fargate is ≈ $0.004 per player-hour; egress was ≈ $0.042 per
  player-hour before optimisation and ≈ $0.009 after (measured). Delta encoding, half-resolution bodies and
  permessage-deflate were all driven by this measurement. Remaining levers: a 10 Hz snapshot rate, binary
  encoding, a smaller area of interest.
* **Scale-to-demand.** At 3 a.m. with 4 humans the service runs 2 tasks (≈ $0.02/h), not the peak's 67.
  Minimum cost floor ≈ ALB ($18.4) + 1 task ($8.6) + CloudWatch ≈ **$40/month**.
* **Peak 200 humans** → 67 tasks ≈ $0.79/h of Fargate. The demo cap of `MaxTasks = 6` (24 humans) is a
  deliberate cost guard, raised with `BACKEND_EXTRA_PARAMS="MaxTasks=70"`.
* **Not counted:** the account's pre-existing NAT gateways (used only for ECR pulls, SQS, Secrets Manager:
  ~100 MB per task start + KBs of API calls).

## AWS Pricing Calculator: exact inputs

Create an estimate at https://calculator.aws/ (Region **Asia Pacific (Sydney)**), add these services, then
**Save and share** and paste the public link into the report. *(The link must be created by you; it is not invented here.)*

1. **AWS Fargate**: OS Linux, CPU architecture **ARM**, number of tasks **20** per day, average duration **24 hours**
   (or "730 hours per month"), vCPU **0.25**, memory **0.5 GB**, ephemeral storage 20 GB (default, no charge).
2. **Elastic Load Balancing**: Application Load Balancer, 1 ALB, processed bytes **4.7 GB per hour** (EC2/IP targets),
   average new connections **1 per second**, average connection duration **600 s**, rule evaluations default.
3. **Amazon CloudFront**: Australia, data transfer out to internet **3,416 GB/month**, number of HTTPS requests
   **100,000/month**, data transfer out to origin **20 GB/month**.
4. **AWS Lambda** (two entries or one combined): ARM, **200,000** requests/month, **50 ms**, **256 MB**;
   ARM, **300,000** requests/month, **20 ms**, **128 MB**.
5. **Amazon SQS**: Standard queue, **1.3 million** requests/month.
6. **Amazon DynamoDB**: On-demand, Standard table class, storage **1 GB**, writes **6.5 million**, reads **0.5 million**.
7. **Amazon CloudWatch**: **25** custom/other metrics, **9** standard alarms, **10 GB** logs ingested (standard), **10 GB** stored, **1** dashboard (first 3 free).
8. **Amazon ECR**: **0.3 GB** storage. **AWS Secrets Manager**: **1** secret, 10,000 API calls.
