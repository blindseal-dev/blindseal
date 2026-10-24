#!/usr/bin/env bash
# Deploy the public site to AWS App Runner (container from ECR). Idempotent: creates the ECR repo
# and the service on first run, updates the image afterwards. Prints the HTTPS URL at the end.
#
#   AWS_PROFILE=<profile> scripts/deploy-site.sh            # region from the profile (default us-east-1)
#   BLINDSEAL_RPC_URL=https://… AWS_PROFILE=… scripts/deploy-site.sh   # explorer's mainnet RPC (default: SSM /blindseal/site/BLINDSEAL_RPC_URL)
#
# The repo never names the AWS account; the service URL is App Runner's random subdomain unless a
# custom domain is attached later. Image is linux/amd64 (App Runner), built with buildx.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
: "${AWS_PROFILE:?set AWS_PROFILE to the deploying profile}"
REGION="${AWS_REGION:-$(aws configure get region --profile "$AWS_PROFILE" 2>/dev/null || echo us-east-1)}"
export AWS_REGION="$REGION"
SERVICE="${BLINDSEAL_SITE_SERVICE:-blindseal-site}"
REPO="${BLINDSEAL_SITE_REPO:-blindseal-site}"
# the explorer's mainnet RPC: the env var if given, else the SecureString in SSM Parameter Store
# (/blindseal/site/BLINDSEAL_RPC_URL — the key never lives in the repo), else the public endpoint
RPC="${BLINDSEAL_RPC_URL:-$(aws ssm get-parameter --name /blindseal/site/BLINDSEAL_RPC_URL --with-decryption --query Parameter.Value --output text 2>/dev/null || true)}"
RPC="${RPC:-https://api.mainnet-beta.solana.com}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
TAG="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d%H%M)"
IMAGE="$ECR/$REPO:$TAG"

echo "→ ECR repo $REPO"
aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$REPO" --image-scanning-configuration scanOnPush=true --image-tag-mutability IMMUTABLE >/dev/null
aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR" >/dev/null

echo "→ build + push $IMAGE (linux/amd64)"
docker buildx build --platform linux/amd64 -f apps/site/Dockerfile -t "$IMAGE" --push .

echo "→ App Runner access role (pulls from ECR)"
ROLE="${SERVICE}-ecr-access"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null || true)
if [ -z "$ROLE_ARN" ]; then
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE" --query Role.Arn --output text --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}')
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
  echo "   new role — waiting 75s for IAM propagation (App Runner pulls with it at create time)"
  sleep 75
fi
# a service left in CREATE_FAILED must be deleted before the name can be reused
OLD=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='$SERVICE' && Status=='CREATE_FAILED'].ServiceArn" --output text)
if [ -n "$OLD" ] && [ "$OLD" != "None" ]; then
  echo "→ deleting failed service $OLD"; aws apprunner delete-service --service-arn "$OLD" >/dev/null
  for i in $(seq 1 30); do aws apprunner describe-service --service-arn "$OLD" >/dev/null 2>&1 || break; sleep 10; done
fi

SRC=$(cat <<JSON
{"ImageRepository":{"ImageIdentifier":"$IMAGE","ImageRepositoryType":"ECR","ImageConfiguration":{"Port":"3000","RuntimeEnvironmentVariables":{"BLINDSEAL_RPC_URL":"$RPC","NODE_ENV":"production","HOSTNAME":"0.0.0.0"}}},
 "AutoDeploymentsEnabled":false,"AuthenticationConfiguration":{"AccessRoleArn":"$ROLE_ARN"}}
JSON
)
ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='$SERVICE'].ServiceArn" --output text)
if [ -z "$ARN" ] || [ "$ARN" = "None" ]; then
  echo "→ create service $SERVICE"
  ARN=$(aws apprunner create-service --service-name "$SERVICE" --source-configuration "$SRC" \
    --instance-configuration '{"Cpu":"0.5 vCPU","Memory":"1 GB"}' \
    --health-check-configuration '{"Protocol":"HTTP","Path":"/","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}' \
    --query Service.ServiceArn --output text)
else
  echo "→ update service $SERVICE"
  aws apprunner update-service --service-arn "$ARN" --source-configuration "$SRC" >/dev/null
fi
echo "→ waiting for RUNNING (a create takes ~8–10 min)"
for i in $(seq 1 90); do
  ST=$(aws apprunner describe-service --service-arn "$ARN" --query Service.Status --output text)
  [ "$ST" = "RUNNING" ] && break
  [ "$ST" = "CREATE_FAILED" ] || [ "$ST" = "UPDATE_FAILED" ] && { echo "service $ST"; aws apprunner list-operations --service-arn "$ARN" --max-results 3; exit 1; }
  sleep 10
done
URL=$(aws apprunner describe-service --service-arn "$ARN" --query Service.ServiceUrl --output text)
echo "site: https://$URL  (image $TAG, status $ST)"
curl -fsS -o /dev/null -w "GET / → %{http_code}\n" "https://$URL/" || true
curl -fsS -o /dev/null -w "GET /blindseal_verifier_bg.wasm → %{http_code} %{content_type}\n" "https://$URL/blindseal_verifier_bg.wasm" || true
