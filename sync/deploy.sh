#!/usr/bin/env bash
# Creates/updates the Ravist -> S3 shows sync (bucket, IAM role, Lambda, daily schedule). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

REGION=ap-south-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=nephra-music-shows-$ACCOUNT
FN=nephra-ravist-sync
ROLE=nephra-ravist-sync-role
SCHED=nephra-ravist-sync-daily
SCHED_ROLE=nephra-ravist-scheduler-role

echo "== bucket $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region $REGION --create-bucket-configuration LocationConstraint=$REGION >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicReadShows\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/shows/*\"}]}"
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration \
  '{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":3600}]}'

echo "== lambda role"
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10
fi
aws iam put-role-policy --role-name $ROLE --policy-name shows-bucket-write --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/shows/*\"},{\"Effect\":\"Allow\",\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::$BUCKET\"}]}"
ROLE_ARN=$(aws iam get-role --role-name $ROLE --query Role.Arn --output text)

echo "== lambda $FN"
python -c "import zipfile; z=zipfile.ZipFile('function.zip','w'); z.write('ravist_sync.py'); z.close()"
if aws lambda get-function --function-name $FN --region $REGION >/dev/null 2>&1; then
  aws lambda update-function-code --function-name $FN --zip-file fileb://function.zip --region $REGION >/dev/null
  aws lambda wait function-updated --function-name $FN --region $REGION
  aws lambda update-function-configuration --function-name $FN --region $REGION --timeout 120 --memory-size 256 \
    --environment "Variables={BUCKET=$BUCKET}" >/dev/null
else
  aws lambda create-function --function-name $FN --region $REGION --runtime python3.13 --handler ravist_sync.handler \
    --role "$ROLE_ARN" --zip-file fileb://function.zip --timeout 120 --memory-size 256 \
    --environment "Variables={BUCKET=$BUCKET}" >/dev/null
fi
aws lambda wait function-updated --function-name $FN --region $REGION
rm -f function.zip
FN_ARN=$(aws lambda get-function --function-name $FN --region $REGION --query Configuration.FunctionArn --output text)

echo "== schedule (daily 06:00 IST)"
if ! aws iam get-role --role-name $SCHED_ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $SCHED_ROLE --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  sleep 10
fi
aws iam put-role-policy --role-name $SCHED_ROLE --policy-name invoke-sync --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"$FN_ARN\"}]}"
SCHED_ROLE_ARN=$(aws iam get-role --role-name $SCHED_ROLE --query Role.Arn --output text)
ARGS=(--name $SCHED --region $REGION --schedule-expression "cron(0 6 * * ? *)" --schedule-expression-timezone Asia/Kolkata
      --flexible-time-window Mode=OFF --target "{\"Arn\":\"$FN_ARN\",\"RoleArn\":\"$SCHED_ROLE_ARN\"}")
aws scheduler update-schedule "${ARGS[@]}" >/dev/null 2>&1 || aws scheduler create-schedule "${ARGS[@]}" >/dev/null

echo "== first run"
aws lambda invoke --function-name $FN --region $REGION --cli-read-timeout 150 out.json >/dev/null && cat out.json && rm -f out.json
echo
echo "Feed: https://$BUCKET.s3.$REGION.amazonaws.com/shows/shows.json"
