#!/usr/bin/env bash
# Zip each Lambda with the shared lib/ and upload to the artifacts bucket under a content hash,
# so CloudFormation only updates a function when its code actually changed.
source "$(dirname "$0")/config.sh"
build="$REPO_ROOT/.build/lambda"
rm -rf "$build" && mkdir -p "$build"
for fn in event-worker leaderboard-api; do
    stage="$build/$fn"
    mkdir -p "$stage"
    cp -R "$REPO_ROOT/lambda/lib" "$REPO_ROOT/lambda/$fn" "$stage/"
    (cd "$stage" && find . -type f -print0 | sort -z | xargs -0 touch -t 202601010000 && zip -qrX "../$fn.zip" .)
    hash=$(shasum -a 256 "$build/$fn.zip" | cut -c1-12)
    key="lambda/$fn-$hash.zip"
    aws s3 cp --quiet "$build/$fn.zip" "s3://$ARTIFACTS_BUCKET/$key"
    echo "$key" > "$STATE_DIR/$fn.key"
    log "Uploaded s3://$ARTIFACTS_BUCKET/$key"
done
