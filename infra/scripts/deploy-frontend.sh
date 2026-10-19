#!/usr/bin/env bash
# Build the client, deploy the CloudFront stack, and upload the build to S3 with cache headers:
#   fingerprinted files -> Cache-Control: public, max-age=31536000, immutable (safe: name changes with content)
#   index.html          -> Cache-Control: no-cache (always revalidated so new builds go live immediately)
source "$(dirname "$0")/config.sh"
"$(dirname "$0")/ensure-buckets.sh"

if [[ "${SKIP_STACK:-0}" != 1 ]]; then
    secret="$("$(dirname "$0")/ensure-origin-secret.sh")"
    deploy_stack "$STACK_FRONTEND" "$REPO_ROOT/infra/cloudformation/frontend.yml" \
        Prefix="$PREFIX" QutUsername="$QUT_USERNAME" FrontendBucket="$FRONTEND_BUCKET" \
        AlbDnsName="$(stack_output "$STACK_BACKEND" LoadBalancerDns)" OriginVerifySecret="$secret"
fi

log "Building client"
node "$REPO_ROOT/client/build.mjs" >/dev/null
dist="$REPO_ROOT/client/dist"

log "Uploading immutable assets"
aws s3 sync "$dist" "s3://$FRONTEND_BUCKET/" --exclude index.html --exclude cache-manifest.json \
    --cache-control "public, max-age=31536000, immutable" --only-show-errors
log "Uploading index.html (no-cache)"
aws s3 cp "$dist/index.html" "s3://$FRONTEND_BUCKET/index.html" \
    --cache-control "no-cache" --content-type "text/html; charset=utf-8" --only-show-errors

# Old fingerprinted files are left in place on purpose: browsers holding the previous index.html
# can still load them. Only index.html needs an edge invalidation.
dist_id="$(stack_output "$STACK_FRONTEND" DistributionId)"
aws cloudfront create-invalidation --distribution-id "$dist_id" --paths /index.html /  >/dev/null
log "Frontend live: $(stack_output "$STACK_FRONTEND" AppUrl)"
