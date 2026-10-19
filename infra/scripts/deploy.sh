#!/usr/bin/env bash
# Full deployment, in dependency order. Rerunnable: every step is idempotent.
#   AWS_PROFILE=default infra/scripts/deploy.sh
# Steps can be skipped with SKIP_IMAGE=1 (reuse infra/.state/image-uri) or SKIP_FRONTEND=1.
source "$(dirname "$0")/config.sh"
here="$(dirname "$0")"

log "Account $ACCOUNT_ID, region $AWS_REGION, prefix $PREFIX"
deploy_stack "$STACK_DATA" "$REPO_ROOT/infra/cloudformation/data.yml" Prefix="$PREFIX" QutUsername="$QUT_USERNAME"
"$here/ensure-buckets.sh"
"$here/ensure-log-groups.sh"
"$here/package-lambdas.sh"
"$here/deploy-lambdas.sh"
[[ "${SKIP_IMAGE:-0}" == 1 && -f "$STATE_DIR/image-uri" ]] || "$here/build-push-server.sh"
"$here/deploy-backend.sh"
[[ "${SKIP_FRONTEND:-0}" == 1 ]] || "$here/deploy-frontend.sh"
"$here/deploy-monitoring.sh"
log "Done. App: $(stack_output "$STACK_FRONTEND" AppUrl)"
