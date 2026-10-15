#!/usr/bin/env bash
# Deploys the press-access stack and (re)uploads private assets + zips. Region ap-south-1.
set -euo pipefail
cd "$(dirname "$0")"
export AWS_REGION=ap-south-1
ACCT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=nephra-press-assets-$ACCT
STAGE=$(mktemp -d)
CODE_BUCKET=nephra-press-code-$ACCT
aws s3api head-bucket --bucket "$CODE_BUCKET" 2>/dev/null || aws s3api create-bucket --bucket "$CODE_BUCKET" --create-bucket-configuration LocationConstraint=$AWS_REGION >/dev/null
(cd lambda && zip -qr "$STAGE/fn.zip" index.mjs)
KEY=fn-$(shasum "$STAGE/fn.zip" | cut -c1-12).zip
aws s3 cp "$STAGE/fn.zip" "s3://$CODE_BUCKET/$KEY" --only-show-errors
aws cloudformation deploy --stack-name nephra-press-access --template-file template.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides CodeBucket=$CODE_BUCKET CodeKey=$KEY --no-fail-on-empty-changeset
if [ -d private-assets ]; then
  rm -rf "$STAGE/z" && mkdir -p "$STAGE/z"
  (cd private-assets/photos && zip -qj "$STAGE/z/NEPHRA-Press-Photos.zip" *.jpg)
  (cd private-assets/logos && zip -qj "$STAGE/z/NEPHRA-Logos.zip" *.png)
  (cd private-assets && zip -qr "$STAGE/z/NEPHRA-Complete-Press-Kit.zip" photos logos)
  aws s3 sync private-assets "s3://$BUCKET/" --only-show-errors
  aws s3 sync "$STAGE/z" "s3://$BUCKET/zips/" --only-show-errors
fi
aws cloudformation describe-stacks --stack-name nephra-press-access --query 'Stacks[0].Outputs' --output table
