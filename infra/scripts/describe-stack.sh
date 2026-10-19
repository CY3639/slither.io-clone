#!/usr/bin/env bash
# Print the deployed resource inventory (stack outputs, ECS service, Lambdas, buckets, tags).
source "$(dirname "$0")/config.sh"
for s in "$STACK_DATA" "$STACK_BACKEND" "$STACK_FRONTEND" "$STACK_MONITORING"; do
    echo "== $s ($(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING))"
    aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text 2>/dev/null | sed 's/^/   /'
done
echo "== ECS service"
aws ecs describe-services --cluster "$PREFIX-cluster" --services "$PREFIX-game" \
    --query 'services[0].[serviceArn,desiredCount,runningCount,taskDefinition]' --output text | sed 's/^/   /'
echo "== Lambda functions"
for fn in "$PREFIX-event-worker" "$PREFIX-leaderboard-api"; do
    aws lambda get-function-configuration --function-name "$fn" --query '[FunctionArn,Runtime,Architectures[0],MemorySize]' --output text | sed 's/^/   /'
done
aws lambda list-event-source-mappings --function-name "$PREFIX-event-worker" --query 'EventSourceMappings[].[UUID,State,BatchSize,EventSourceArn]' --output text | sed 's/^/   ESM /'
echo "== Buckets"
for b in "$FRONTEND_BUCKET" "$ARTIFACTS_BUCKET"; do echo "   arn:aws:s3:::$b"; done
echo "== Resources tagged qut-username=$QUT_USERNAME, purpose=assessment 3"
aws resourcegroupstaggingapi get-resources --tag-filters "Key=purpose,Values=assessment 3" "Key=qut-username,Values=$QUT_USERNAME" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | sort | sed 's/^/   /'
