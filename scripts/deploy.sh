#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=ap-northeast-2}"
: "${STACK_NAME:?Set a dedicated stack name}"
: "${DOMAIN_NAME:?Set the HTTPS demo hostname}"
: "${HOSTED_ZONE_ID:?Set its Route53 hosted zone ID}"
: "${CERTIFICATE_ARN:?Set an issued ACM certificate ARN in this region}"
: "${ARTIFACT_BUCKET:?Set a private deployment artifact bucket}"

cd "$(dirname "$0")/.."
git diff --quiet
git diff --cached --quiet
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo 'Commit the release files before deploying.' >&2
  exit 1
fi
release_sha="$(git rev-parse HEAD)"
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]]

pnpm typecheck
pnpm test
pnpm build
mkdir -p .local
rm -f .local/lambda.zip
(cd dist && zip -q ../.local/lambda.zip lambda.mjs)
artifact_digest="$(node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(readFileSync(".local/lambda.zip")).digest("hex"))')"
artifact_key="releases/${release_sha}/${artifact_digest}.zip"
aws s3 cp .local/lambda.zip "s3://${ARTIFACT_BUCKET}/${artifact_key}" \
  --region "$AWS_REGION" --only-show-errors
aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/template.yml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --tags Application=mizi-oidc-example Environment=demo \
  --parameter-overrides \
    DomainName="$DOMAIN_NAME" HostedZoneId="$HOSTED_ZONE_ID" \
    CertificateArn="$CERTIFICATE_ARN" ArtifactBucket="$ARTIFACT_BUCKET" \
    ArtifactKey="$artifact_key" ReleaseSha="$release_sha"

DEMO_URL="https://${DOMAIN_NAME}" EXPECTED_RELEASE="$release_sha" node --input-type=module <<'NODE'
const response = await fetch(process.env.DEMO_URL + '/health', { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
const body = await response.json();
if (body.releaseSha !== process.env.EXPECTED_RELEASE) throw new Error('Release SHA mismatch');
console.log(`Verified ${process.env.DEMO_URL} at ${body.releaseSha}`);
NODE
