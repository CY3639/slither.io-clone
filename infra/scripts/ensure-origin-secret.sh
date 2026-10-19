#!/usr/bin/env bash
# Shared secret CloudFront sends as X-Origin-Verify; the ALB only forwards requests carrying it.
# Kept in SSM Parameter Store (SecureString) so redeploys reuse the same value.
source "$(dirname "$0")/config.sh"
if ! aws ssm get-parameter --name "$ORIGIN_SECRET_PARAM" >/dev/null 2>&1; then
    log "Creating $ORIGIN_SECRET_PARAM"
    aws ssm put-parameter --name "$ORIGIN_SECRET_PARAM" --type SecureString \
        --value "$(openssl rand -hex 32)" \
        --tags "Key=purpose,Value=assessment 3" "Key=qut-username,Value=$QUT_USERNAME" >/dev/null
fi
aws ssm get-parameter --name "$ORIGIN_SECRET_PARAM" --with-decryption --query Parameter.Value --output text
