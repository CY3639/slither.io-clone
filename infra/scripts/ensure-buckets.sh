#!/usr/bin/env bash
# Create the S3 buckets if missing (idempotent). Buckets live outside CloudFormation because this
# account denies s3:DeleteBucket, which makes a failed stack unable to roll a bucket back.
source "$(dirname "$0")/config.sh"

ensure_bucket() {
    local bucket="$1"
    if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
        log "Bucket $bucket exists"
    else
        log "Creating bucket $bucket"
        aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
    fi
    aws s3api put-public-access-block --bucket "$bucket" \
        --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    # New buckets in this account have S3 ABAC enabled, so tags go through S3 Control TagResource.
    aws s3control tag-resource --account-id "$ACCOUNT_ID" --resource-arn "arn:aws:s3:::$bucket" \
        --tags "[{\"Key\":\"purpose\",\"Value\":\"assessment 3\"},{\"Key\":\"qut-username\",\"Value\":\"$QUT_USERNAME\"}]"
}

ensure_bucket "$ARTIFACTS_BUCKET"
ensure_bucket "$FRONTEND_BUCKET"
