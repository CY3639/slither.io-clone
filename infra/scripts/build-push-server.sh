#!/usr/bin/env bash
# Build the game server image for linux/arm64 (Fargate Graviton) and push it to ECR.
source "$(dirname "$0")/config.sh"
repo_uri="$(stack_output "$STACK_DATA" RepositoryUri)"
[[ -n "$repo_uri" && "$repo_uri" != None ]] || die "data stack not deployed (no RepositoryUri)"
tag="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)}"

log "Building $repo_uri:$tag"
docker build --platform linux/arm64 -t "$repo_uri:$tag" "$REPO_ROOT/server" >&2
aws ecr get-login-password | docker login --username AWS --password-stdin "${repo_uri%%/*}" >&2
docker push "$repo_uri:$tag" >&2
echo "$repo_uri:$tag" > "$STATE_DIR/image-uri"
log "Pushed $repo_uri:$tag"
