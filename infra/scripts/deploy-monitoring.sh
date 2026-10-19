#!/usr/bin/env bash
# CloudWatch dashboard + alarms (needs the data, backend and frontend stacks).
source "$(dirname "$0")/config.sh"
deploy_stack "$STACK_MONITORING" "$REPO_ROOT/infra/cloudformation/monitoring.yml" \
    Prefix="$PREFIX" QutUsername="$QUT_USERNAME" DistributionId="$(stack_output "$STACK_FRONTEND" DistributionId)"
log "Dashboard: $(stack_output "$STACK_MONITORING" DashboardUrl)"
