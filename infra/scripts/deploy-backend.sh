#!/usr/bin/env bash
# ALB + ECS Fargate service + autoscaling + Lambdas. Requires: data stack, image, lambda packages.
source "$(dirname "$0")/config.sh"
"$(dirname "$0")/ensure-log-groups.sh"
image="${IMAGE_URI:-$(cat "$STATE_DIR/image-uri")}"
secret="$("$(dirname "$0")/ensure-origin-secret.sh")"
deploy_stack "$STACK_BACKEND" "$REPO_ROOT/infra/cloudformation/backend.yml" \
    Prefix="$PREFIX" QutUsername="$QUT_USERNAME" VpcId="$VPC_ID" \
    PublicSubnets="$PUBLIC_SUBNETS" PrivateSubnets="$PRIVATE_SUBNETS" SecurityGroupId="$SECURITY_GROUP_ID" \
    GameLogGroupName="$GAME_LOG_GROUP" OriginVerifySecret="$secret" ImageUri="$image" \
    ApiFunctionArn="$(cat "$STATE_DIR/api-arn")" \
    ${BACKEND_EXTRA_PARAMS:-}
log "Backend ready: ALB $(stack_output "$STACK_BACKEND" LoadBalancerDns)"
