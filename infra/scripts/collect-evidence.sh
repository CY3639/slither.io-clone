#!/usr/bin/env bash
# Snapshot the deployed system's state into evidence/aws/ (text only; screenshots are listed in
# evidence/screenshots-needed.md). Safe to rerun; files are timestamped.
source "$(dirname "$0")/config.sh"
out="$REPO_ROOT/evidence/aws"
mkdir -p "$out"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
app="$(stack_output "$STACK_FRONTEND" AppUrl)"

log "Resource inventory"
"$(dirname "$0")/describe-stack.sh" > "$out/inventory-$ts.txt"

log "Scaling activity history"
aws application-autoscaling describe-scaling-activities --service-namespace ecs \
    --resource-id "service/$PREFIX-cluster/$PREFIX-game" --max-items 30 \
    --query 'ScalingActivities[].[StartTime,StatusCode,Description,Cause]' --output text > "$out/E11-scaling-activities-$ts.txt"

log "ECS service events"
aws ecs describe-services --cluster "$PREFIX-cluster" --services "$PREFIX-game" \
    --query 'services[0].events[0:30].[createdAt,message]' --output text > "$out/E12-ecs-service-events-$ts.txt"

log "ALB target health"
aws elbv2 describe-target-health --target-group-arn "$(stack_output "$STACK_BACKEND" GameTargetGroupArn)" \
    --query 'TargetHealthDescriptions[].[Target.Id,Target.AvailabilityZone,TargetHealth.State]' --output text > "$out/E13-target-health-$ts.txt"

log "CloudWatch metric exports (last 2 h, 1-minute)"
start="$(date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)"; end="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$STATE_DIR/metric-queries.json" <<JSON
[
 {"Id":"desired","MetricStat":{"Metric":{"Namespace":"ECS/ContainerInsights","MetricName":"DesiredTaskCount","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"},{"Name":"ClusterName","Value":"$PREFIX-cluster"}]},"Period":60,"Stat":"Maximum"}},
 {"Id":"running","MetricStat":{"Metric":{"Namespace":"ECS/ContainerInsights","MetricName":"RunningTaskCount","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"},{"Name":"ClusterName","Value":"$PREFIX-cluster"}]},"Period":60,"Stat":"Maximum"}},
 {"Id":"occupancy","MetricStat":{"Metric":{"Namespace":"n5528712/A3Game","MetricName":"WorldOccupancyPct","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"}]},"Period":60,"Stat":"Average"}},
 {"Id":"humans","MetricStat":{"Metric":{"Namespace":"n5528712/A3Game","MetricName":"HumanPlayers","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"}]},"Period":60,"Stat":"Sum"}},
 {"Id":"cpu","MetricStat":{"Metric":{"Namespace":"AWS/ECS","MetricName":"CPUUtilization","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"},{"Name":"ClusterName","Value":"$PREFIX-cluster"}]},"Period":60,"Stat":"Average"}},
 {"Id":"cpumax","MetricStat":{"Metric":{"Namespace":"AWS/ECS","MetricName":"CPUUtilization","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"},{"Name":"ClusterName","Value":"$PREFIX-cluster"}]},"Period":60,"Stat":"Maximum"}},
 {"Id":"mem","MetricStat":{"Metric":{"Namespace":"AWS/ECS","MetricName":"MemoryUtilization","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"},{"Name":"ClusterName","Value":"$PREFIX-cluster"}]},"Period":60,"Stat":"Average"}},
 {"Id":"tickp99","MetricStat":{"Metric":{"Namespace":"n5528712/A3Game","MetricName":"TickDurationP99Ms","Dimensions":[{"Name":"ServiceName","Value":"$PREFIX-game"}]},"Period":60,"Stat":"Maximum"}},
 {"Id":"sqssent","MetricStat":{"Metric":{"Namespace":"AWS/SQS","MetricName":"NumberOfMessagesSent","Dimensions":[{"Name":"QueueName","Value":"$PREFIX-events"}]},"Period":60,"Stat":"Sum"}},
 {"Id":"lambdainv","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Invocations","Dimensions":[{"Name":"FunctionName","Value":"$PREFIX-event-worker"}]},"Period":60,"Stat":"Sum"}},
 {"Id":"lambdaerr","MetricStat":{"Metric":{"Namespace":"AWS/Lambda","MetricName":"Errors","Dimensions":[{"Name":"FunctionName","Value":"$PREFIX-event-worker"}]},"Period":60,"Stat":"Sum"}},
 {"Id":"ddbwcu","MetricStat":{"Metric":{"Namespace":"AWS/DynamoDB","MetricName":"ConsumedWriteCapacityUnits","Dimensions":[{"Name":"TableName","Value":"$PREFIX-game"}]},"Period":60,"Stat":"Sum"}}
]
JSON
aws cloudwatch get-metric-data --metric-data-queries "file://$STATE_DIR/metric-queries.json" --start-time "$start" --end-time "$end" \
    --scan-by TimestampAscending --output json > "$out/E15-cloudwatch-metrics-$ts.json"
node -e '
const d=require(process.argv[1]); const rows={};
for (const r of d.MetricDataResults) r.Timestamps.forEach((t,i)=>{(rows[t]??={})[r.Id]=r.Values[i]});
const ids=d.MetricDataResults.map(r=>r.Id); console.log(["time",...ids].join(","));
for (const t of Object.keys(rows).sort()) console.log([t.slice(11,16),...ids.map(i=>rows[t][i]===undefined?"":+rows[t][i].toFixed(1))].join(","));
' "$out/E15-cloudwatch-metrics-$ts.json" > "$out/E15-cloudwatch-metrics-$ts.csv"

log "Queue depths"
for q in "$PREFIX-events" "$PREFIX-events-dlq"; do
    url="$(aws sqs get-queue-url --queue-name "$q" --output text)"
    echo "$q $(aws sqs get-queue-attributes --queue-url "$url" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible --query Attributes --output json | tr -d '\n ')"
done > "$out/E7-queue-depths-$ts.txt"

log "Leaderboard (DynamoDB GSI query and public API)"
aws dynamodb query --table-name "$PREFIX-game" --index-name GSI1 --key-condition-expression 'GSI1PK = :lb' \
    --expression-attribute-values '{":lb":{"S":"LB"}}' --no-scan-index-forward --limit 10 --output json > "$out/E9-dynamodb-leaderboard-$ts.json"
curl -fsS "${app}api/leaderboard?limit=10" > "$out/E9-api-leaderboard-$ts.json" || true

log "Evidence written to $out (suffix $ts)"
