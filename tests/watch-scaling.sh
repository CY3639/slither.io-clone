#!/usr/bin/env bash
# Poll the ECS service every INTERVAL seconds and print one line per sample: desired/running/pending
# tasks, healthy ALB targets, latest occupancy and CPU datapoints, and the newest scaling activity.
# Usage: tests/watch-scaling.sh [interval_s] [samples]    (Ctrl+C to stop)
source "$(dirname "$0")/../infra/scripts/config.sh"
INTERVAL="${1:-30}"
SAMPLES="${2:-1000000}"
CLUSTER="${PREFIX}-cluster"
SERVICE="${PREFIX}-game"
TG="$(stack_output "$STACK_BACKEND" GameTargetGroupArn)"

latest() { # latest <namespace> <metric> <stat> <dims...>
    local ns="$1" metric="$2" stat="$3"; shift 3
    aws cloudwatch get-metric-statistics --namespace "$ns" --metric-name "$metric" --statistics "$stat" \
        --period 60 --start-time "$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ)" --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --dimensions "$@" --query "sort_by(Datapoints,&Timestamp)[-1].$stat" --output text 2>/dev/null | awk '{ printf "%s", ($1=="None"?"-":sprintf("%.1f",$1)) }'
}

printf '%-20s %-7s %-7s %-7s %-7s %-9s %-7s %s\n' time desired running pending healthy occup% cpu% last-scaling-activity
for ((i = 0; i < SAMPLES; i++)); do
    read -r desired running pending < <(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'services[0].[desiredCount,runningCount,pendingCount]' --output text)
    healthy="$(aws elbv2 describe-target-health --target-group-arn "$TG" --query "length(TargetHealthDescriptions[?TargetHealth.State=='healthy'])" --output text)"
    occ="$(latest n5528712/A3Game WorldOccupancyPct Average Name=ServiceName,Value="$SERVICE")"
    cpu="$(latest AWS/ECS CPUUtilization Average Name=ClusterName,Value="$CLUSTER" Name=ServiceName,Value="$SERVICE")"
    act="$(aws application-autoscaling describe-scaling-activities --service-namespace ecs --resource-id "service/$CLUSTER/$SERVICE" \
        --max-items 1 --query 'ScalingActivities[0].[StartTime,Description]' --output text | head -1 | cut -c1-110)"
    printf '%-20s %-7s %-7s %-7s %-7s %-9s %-7s %s\n' "$(date +%H:%M:%S)" "$desired" "$running" "$pending" "$healthy" "$occ" "$cpu" "$act"
    sleep "$INTERVAL"
done
