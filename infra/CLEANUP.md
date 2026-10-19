# Cleanup / teardown

**Nothing here runs automatically.** Evidence collection and the report may still depend on the deployment.
Run these steps only after the assessment is submitted and marked.

```bash
export AWS_PROFILE=default AWS_REGION=ap-southeast-2 AWS_PAGER=""
```

## 1. Stop paying for compute first (cheap, reversible)

The ALB (about US$0.6/day) and Fargate tasks are the only always-on costs.

```bash
# Scale the game service to zero and stop autoscaling from bringing tasks back
aws application-autoscaling register-scalable-target --service-namespace ecs \
  --resource-id service/n5528712-a3-cluster/n5528712-a3-game \
  --scalable-dimension ecs:service:DesiredCount --min-capacity 0 --max-capacity 0
aws ecs update-service --cluster n5528712-a3-cluster --service n5528712-a3-game --desired-count 0
```

## 2. Delete the stacks (reverse dependency order)

```bash
aws cloudformation delete-stack --stack-name n5528712-a3-monitoring
aws cloudformation wait stack-delete-complete --stack-name n5528712-a3-monitoring

# CloudFront deletion takes ~5-15 min (the distribution is disabled, then deleted)
aws cloudformation delete-stack --stack-name n5528712-a3-frontend
aws cloudformation wait stack-delete-complete --stack-name n5528712-a3-frontend

# ALB, target groups, ECS cluster/service/task definition, autoscaling policies
aws cloudformation delete-stack --stack-name n5528712-a3-backend
aws cloudformation wait stack-delete-complete --stack-name n5528712-a3-backend

# SQS queues, ECR repository, secret. The DynamoDB table has DeletionPolicy Retain.
aws ecr batch-delete-image --repository-name a3/n5528712-a3-game \
  --image-ids "$(aws ecr list-images --repository-name a3/n5528712-a3-game --query 'imageIds' --output json)"
aws cloudformation delete-stack --stack-name n5528712-a3-data
aws cloudformation wait stack-delete-complete --stack-name n5528712-a3-data
```

## 3. Resources managed by script

```bash
aws lambda delete-event-source-mapping --uuid "$(aws lambda list-event-source-mappings \
  --function-name n5528712-a3-event-worker --query 'EventSourceMappings[0].UUID' --output text)"
aws lambda delete-function --function-name n5528712-a3-event-worker
aws lambda delete-function --function-name n5528712-a3-leaderboard-api
aws ssm delete-parameter --name /n5528712/a3/origin-verify-secret
aws cloudfront delete-monitoring-subscription --distribution-id <id>   # only if the frontend stack failed to delete
```

## 4. Resources the student role cannot delete (account deny policy)

The CAB432 account denies these deletions to the `CAB432-STUDENT` role (see `docs/current-state.md`).
They cost little or nothing, but should be listed for teaching staff to remove:

| Resource | Why it remains | Cost while idle |
|----------|----------------|-----------------|
| S3 `n5528712-a3-frontend-901444280953` | `s3:DeleteBucket` denied | ~1 MB stored, negligible. Empty it with `aws s3 rm s3://n5528712-a3-frontend-901444280953 --recursive`. |
| S3 `n5528712-a3-artifacts-901444280953` | `s3:DeleteBucket` denied | Lambda zips (<1 MB). Empty it with `aws s3 rm ... --recursive`. |
| Log groups `/n5528712-a3/game`, `/aws/lambda/n5528712-a3-*` | `logs:DeleteLogGroup` and `PutRetentionPolicy` denied | Storage of a few MB. |
| DynamoDB `n5528712-a3-game` | Retained by design (`DeletionPolicy: Retain`) | On-demand: storage only (KBs). Delete with `aws dynamodb delete-table --table-name n5528712-a3-game` if permitted. |

## 5. Verify nothing billable remains

```bash
aws resourcegroupstaggingapi get-resources --tag-filters "Key=purpose,Values=assessment 3" \
  "Key=qut-username,Values=n5528712@qut.edu.au" --query 'ResourceTagMappingList[].ResourceARN' --output text
aws elbv2 describe-load-balancers --names n5528712-a3-alb 2>&1 | head -1   # expect LoadBalancerNotFound
```
