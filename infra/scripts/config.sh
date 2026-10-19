#!/usr/bin/env bash
# Shared configuration for all deploy scripts. Every value can be overridden from the environment.
# Credentials come from the AWS CLI profile / SSO session; nothing secret is stored in this repo.
set -euo pipefail

export AWS_PAGER=""
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

STUDENT_ID="${STUDENT_ID:-n5528712}"
QUT_USERNAME="${QUT_USERNAME:-n5528712@qut.edu.au}"
PREFIX="${PREFIX:-${STUDENT_ID}-a3}"
TAGS=(purpose="assessment 3" qut-username="$QUT_USERNAME")

# Network: the account's shared Control Tower VPC. ALB in the public subnets, tasks in the private
# subnets (egress through the account's existing NAT gateways). Students cannot create security
# groups, so the course-provided CAB432SG is used.
VPC_ID="${VPC_ID:-vpc-007bab53289655834}"
PUBLIC_SUBNETS="${PUBLIC_SUBNETS:-subnet-05a3b8177138c8b14,subnet-075811427d5564cf9,subnet-04ca053dcbe5f49cc}"
PRIVATE_SUBNETS="${PRIVATE_SUBNETS:-subnet-04cc288ea3b2e1e53,subnet-08e89ff0d9b49c9ae,subnet-05d0352bb15852524}"
SECURITY_GROUP_ID="${SECURITY_GROUP_ID:-sg-032bd1ff8cf77dbb9}"
GAME_LOG_GROUP="/${PREFIX}/game"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}"

STACK_DATA="${PREFIX}-data"
STACK_BACKEND="${PREFIX}-backend"
STACK_FRONTEND="${PREFIX}-frontend"
STACK_MONITORING="${PREFIX}-monitoring"
ORIGIN_SECRET_PARAM="/${STUDENT_ID}/a3/origin-verify-secret"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$REPO_ROOT/infra/.state" # generated values (image URI, code keys); gitignored
mkdir -p "$STATE_DIR"

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null)}" \
    || die "AWS credentials unavailable. Run: aws sso login"
[[ -n "$ACCOUNT_ID" ]] || die "AWS credentials unavailable. Run: aws sso login"
ARTIFACTS_BUCKET="${ARTIFACTS_BUCKET:-${PREFIX}-artifacts-${ACCOUNT_ID}}"
FRONTEND_BUCKET="${FRONTEND_BUCKET:-${PREFIX}-frontend-${ACCOUNT_ID}}"

stack_output() { # stack_output <stack> <key>
    aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

deploy_stack() { # deploy_stack <stack> <template> [Key=Value ...]
    local stack="$1" template="$2"; shift 2
    local params=()
    [[ $# -gt 0 ]] && params=(--parameter-overrides "$@")
    log "Deploying stack $stack"
    # ${arr[@]+...} keeps bash 3.2 (macOS) happy with set -u when the array is empty.
    aws cloudformation deploy --stack-name "$stack" --template-file "$template" \
        --tags "${TAGS[@]}" --no-fail-on-empty-changeset \
        ${params[@]+"${params[@]}"} \
        || { aws cloudformation describe-stack-events --stack-name "$stack" --max-items 30 \
                --query 'StackEvents[?contains(ResourceStatus,`FAILED`)].[LogicalResourceId,ResourceStatusReason]' --output text >&2
             die "stack $stack failed"; }
}
