#!/usr/bin/env bash
# Create log groups with 7-day retention and A3 tags (idempotent). Outside CloudFormation because
# the account denies logs:DeleteLogGroup, so a failed stack could not roll them back.
source "$(dirname "$0")/config.sh"
for group in "$GAME_LOG_GROUP" "/aws/lambda/${PREFIX}-event-worker" "/aws/lambda/${PREFIX}-leaderboard-api"; do
    if [[ -z "$(aws logs describe-log-groups --log-group-name-prefix "$group" --query "logGroups[?logGroupName=='$group'].logGroupName" --output text)" ]]; then
        log "Creating log group $group"
        aws logs create-log-group --log-group-name "$group" --tags "purpose=assessment 3,qut-username=$QUT_USERNAME"
    fi
    # Best effort: the CAB432 student role is not allowed logs:PutRetentionPolicy (see docs/current-state.md).
    aws logs put-retention-policy --log-group-name "$group" --retention-in-days "$LOG_RETENTION_DAYS" 2>/dev/null \
        || log "  retention not permitted for $group (account policy); left at default"
done
log "Log groups ready"
