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
const budgetMs = 180000;
const expectedRelease = process.env.EXPECTED_RELEASE;

async function probe(url, timeoutMs) {
  let response;
  try {
    // Keep normal certificate validation; a newly created custom domain may need
    // time to propagate. Never follow redirects to another host or downgrade TLS.
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return 'HTTPS request failed';
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return `HTTP ${response.status}`;
  }
  let body;
  try { body = await response.json(); } catch { return 'invalid health response'; }
  if (!body || typeof body.releaseSha !== 'string' || !/^[a-f0-9]{40}$/.test(body.releaseSha)) {
    return 'invalid release SHA';
  }
  return body.releaseSha === expectedRelease ? null : 'release SHA mismatch';
}

async function verifyRelease() {
  const base = new URL(process.env.DEMO_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' ||
      base.search || base.hash || !/^[a-f0-9]{40}$/.test(expectedRelease ?? '')) {
    throw new Error('Invalid probe configuration.');
  }
  const deadline = performance.now() + budgetMs;
  let lastFailure = 'HTTPS request failed';
  while (performance.now() < deadline) {
    const remainingMs = Math.max(1, Math.floor(deadline - performance.now()));
    const failure = await probe(new URL('/health', base), Math.min(15000, remainingMs));
    if (failure === null) {
      console.log(`Verified ${base.origin} at ${expectedRelease}`);
      return;
    }
    lastFailure = failure;
    const delayMs = Math.min(5000, Math.max(0, deadline - performance.now()));
    if (delayMs <= 0) break;
    console.warn(`Health verification pending (${lastFailure}); retrying.`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  console.error(`Health verification failed within the 3-minute retry limit (${lastFailure}).`);
  process.exitCode = 1;
}

// Never print fetch/TLS exceptions, response bodies, or their causes.
verifyRelease().catch(() => {
  console.error('Health verification failed: invalid configuration or unexpected probe failure.');
  process.exitCode = 1;
});
NODE
