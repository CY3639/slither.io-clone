#!/usr/bin/env bash
# Create or update both Lambda functions, the ALB invoke permission and the SQS event source
# mapping (idempotent). Done with the CLI rather than CloudFormation because the account's deny
# policy blocks lambda:GetFunction on not-yet-existing functions, which the CloudFormation Lambda
# handler calls before creating; tagged create-function from the CLI is permitted.
source "$(dirname "$0")/config.sh"
LAMBDA_ROLE_ARN="${LAMBDA_ROLE_ARN:-arn:aws:iam::${ACCOUNT_ID}:role/CAB432-Lambda-Role}"
TABLE_NAME="$(stack_output "$STACK_DATA" TableName)"
QUEUE_ARN="$(stack_output "$STACK_DATA" QueueArn)"
TAGS_KV="purpose=assessment 3,qut-username=$QUT_USERNAME"

upsert_function() { # name handler memory timeout codeKey description
    local name="$1" handler="$2" memory="$3" timeout="$4" key="$5" desc="$6"
    local env="Variables={TABLE_NAME=$TABLE_NAME}"
    if aws lambda get-function-configuration --function-name "$name" >/dev/null 2>&1; then
        log "Updating $name"
        aws lambda update-function-code --function-name "$name" --s3-bucket "$ARTIFACTS_BUCKET" --s3-key "$key" >/dev/null
        aws lambda wait function-updated-v2 --function-name "$name"
        aws lambda update-function-configuration --function-name "$name" --handler "$handler" \
            --memory-size "$memory" --timeout "$timeout" --environment "$env" --description "$desc" >/dev/null
        aws lambda wait function-updated-v2 --function-name "$name"
    else
        log "Creating $name"
        aws lambda create-function --function-name "$name" --runtime nodejs22.x --architectures arm64 \
            --role "$LAMBDA_ROLE_ARN" --handler "$handler" --memory-size "$memory" --timeout "$timeout" \
            --code "S3Bucket=$ARTIFACTS_BUCKET,S3Key=$key" --environment "$env" --description "$desc" \
            --tags "$TAGS_KV" >/dev/null
        aws lambda wait function-active-v2 --function-name "$name"
    fi
}

WORKER="${PREFIX}-event-worker"
API="${PREFIX}-leaderboard-api"
upsert_function "$WORKER" event-worker/index.handler 256 10 "$(cat "$STATE_DIR/event-worker.key")" \
    "Applies game events from SQS to DynamoDB (idempotent, partial batch failures)"
upsert_function "$API" leaderboard-api/index.handler 128 5 "$(cat "$STATE_DIR/leaderboard-api.key")" \
    "GET /api/leaderboard and /api/player behind the ALB (edge-cached by CloudFront)"

# The ALB must be allowed to invoke the API function before the Lambda target group registers it.
aws lambda add-permission --function-name "$API" --statement-id alb-invoke --action lambda:InvokeFunction \
    --principal elasticloadbalancing.amazonaws.com >/dev/null 2>&1 || true

# SQS -> worker: batches of 10 (or 2 s), partial batch failures, at most 2 concurrent pollers.
uuid="$(aws lambda list-event-source-mappings --function-name "$WORKER" --event-source-arn "$QUEUE_ARN" \
    --query 'EventSourceMappings[0].UUID' --output text)"
esm_args=(--batch-size 10 --maximum-batching-window-in-seconds 2 --function-response-types ReportBatchItemFailures
          --scaling-config MaximumConcurrency=2)
if [[ "$uuid" == "None" || -z "$uuid" ]]; then
    log "Creating SQS event source mapping"
    aws lambda create-event-source-mapping --function-name "$WORKER" --event-source-arn "$QUEUE_ARN" \
        "${esm_args[@]}" --tags "$TAGS_KV" >/dev/null
else
    aws lambda update-event-source-mapping --uuid "$uuid" "${esm_args[@]}" >/dev/null
fi

aws lambda get-function-configuration --function-name "$WORKER" --query FunctionArn --output text > "$STATE_DIR/worker-arn"
aws lambda get-function-configuration --function-name "$API" --query FunctionArn --output text > "$STATE_DIR/api-arn"
log "Lambdas ready: $(cat "$STATE_DIR/worker-arn"), $(cat "$STATE_DIR/api-arn")"
