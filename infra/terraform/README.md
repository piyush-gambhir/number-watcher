# AWS setup

Each request gets an EventBridge Scheduler rate schedule. A short Node.js 24 Lambda invocation reads its DynamoDB checkpoint, checks providers once, makes permitted purchases, and exits. Pending orders and notification retries continue in later invocations. The initial check runs during submission. No UI, API Gateway, VPC, NAT gateway, or continuously running process is required.

Terraform creates the Lambda deployment, on-demand DynamoDB table, Scheduler group and IAM roles, CloudWatch logs, encrypted SQS failure queue, queue-depth alarm, and optionally an empty Secrets Manager secret. Individual job schedules are managed by the application. No resources have been deployed or real AWS invocations tested during development.

## Build and review

Requirements: Node 24+, Terraform 1.10+, AWS CLI v2, and an AWS profile authorized to create the stack. Dependency and provider lock files are committed. From the repository root:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build:lambda
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform fmt -check
terraform validate
terraform test
```

`terraform test` uses a mocked AWS provider and makes no AWS calls. Edit the region/name in `terraform.tfvars`, select your profile, and review the real plan:

```sh
export AWS_PROFILE=your-deployment-profile
export AWS_REGION=us-east-1
terraform plan -out=deployment.tfplan
```

Set `AWS_REGION` to match `terraform.tfvars`; keep it and `AWS_PROFILE` set for subsequent AWS CLI commands. When ready to provision, run `terraform apply deployment.tfplan`. This creates billable resources. Later code updates need another `npm run build:lambda` from the root before planning and applying. Terraform packages `build/lambda` automatically.

State is local by default and ignored by Git. For shared operation, use an existing encrypted remote backend following your team's state conventions. Credentials never belong in variables, plans, or state. The jobs table has `prevent_destroy` because losing checkpoints could lead to duplicate purchases. Preserve the table and reconcile existing orders before removing that guard. Dynamically created schedules must be cancelled and removed before tearing down their group.

## Populate credentials

From the repository root:

```sh
mkdir -p requests
cp examples/aws-credentials.json requests/credentials.json
chmod 600 requests/credentials.json
```

Edit this ignored file with dedicated credentials and destinations. Remove unused providers/channels. For SMTP, replace the Resend setting/key with `NUMBER_WATCHER_EMAIL_PROVIDER=smtp` and `SMTP_URL`. Use SMTP TLS port 465 or STARTTLS port 587. Email recipients are comma-separated, up to 20 addresses. Resend uses HTTPS and is the simplest initial Lambda email transport.

Upload the JSON directly to Secrets Manager after provisioning:

```sh
aws secretsmanager put-secret-value \
  --secret-id "$(terraform -chdir=infra/terraform output -raw credentials_secret_arn)" \
  --secret-string file://requests/credentials.json
```

Only the secret ARN goes through Terraform. Alternatively set `credentials_secret_arn` to an existing same-region JSON secret before planning. A customer-managed encryption key also needs scoped `kms:Decrypt` permission in the worker policy. Values are read per invocation and excluded from DynamoDB, schedule payloads, and application logs. Terraform does not create your Slack webhook, email account/domain authorization, Twilio Messaging Service, or Telnyx Call Control application/Messaging Profile. UAT credentials are not copied or deployed automatically.

## Submit a request

Copy `examples/notify.json` into `requests/job.json`, edit the account ID/search settings, and remove unused providers/channels. Start with `notify` to verify real inventory and delivery. The examples enable Slack and email. For purchases, use `examples/purchase.json` and supply the existing routes and price ceiling. Submitting purchase mode authorizes real charges for the requested quantity.

```sh
npm run cli -- check --config requests/job.json --offline
npm run cloud:request -- requests/job.json requests/submit.json
aws lambda invoke \
  --function-name "$(terraform -chdir=infra/terraform output -raw function_name)" \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 150 \
  --payload file://requests/submit.json requests/submit-result.json
cat requests/submit-result.json
```

Save the returned `jobId`. Retry the exact same submission file after a network error. Its UUID is the idempotency key, so duplicates cannot reset quantity or extend the deadline. A new UUID creates a separate request and authorizes a separate quantity. The helper refuses to overwrite existing files. AWS CLI reports `FunctionError` in its metadata for failed executions; a successful CLI exit alone does not confirm submission.

The recovery schedule exists before attempting a purchase. Duration starts when the durable job is created. Interval must be a whole number of minutes, 5 to 60 minutes. Scheduler has minute-level precision, so polling is approximate. Calendar schedules and future start times are not implemented. Duplicate ticks before `nextPollAt` skip searching.

## Status and commands

```sh
aws lambda invoke \
  --function-name "$(terraform -chdir=infra/terraform output -raw function_name)" \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 150 \
  --payload '{"command":"status","jobId":"YOUR-JOB-UUID"}' requests/status.json
cat requests/status.json
```

Other commands use the same `jobId`:

| Command | Behavior |
| --- | --- |
| `poll` | One due round or unfinished-order reconciliation. Normally sent by Scheduler. |
| `cancel` | Persist cancellation and stop new purchases. Never release existing numbers. |
| `resume` | Retry a failed/attention job. Retain deadline and quantity; reconcile before buying. |
| `retry-notifications` | Retry outstanding deliveries without searching or purchasing. |

Cloud status is by job ID; there is no cloud list command. Local and cloud jobs use separate stores. Each cloud request has its own conditional lease. An unresolved purchase blocks further purchases within that request. A separate request has a separate quantity, so avoid equivalent requests with different IDs. Different machines invoking the same job share its lease and checkpoint.

## Recovery and limits

The 120-second Lambda timeout has a 180-second DynamoDB lease. Saves require the current lease token and expected revision. Purchase intent is saved before any provider write. A timeout or lost acknowledgement leaves that intent for reconciliation, never an automatic repeat purchase. Provider requests have timeouts; new operations stop near invocation expiry. Large quantities may need several invocations. Five seconds per tick is an estimate for normal checks, not a guarantee.

Telnyx activation is checked on a later tick. Pending orders continue up to ten minutes beyond the purchase deadline, then become `needs_attention` if unresolved. Ambiguous purchases and configuration failures get three recovery attempts across invocations. Owned, pending, and uncertain numbers still occupy their slots. Expiry/cancellation never cancels orders or releases numbers. Inspect status and explicitly resume after resolving a problem.

Notifications are checkpointed per event/channel. Each cloud delivery pass makes one attempt per delivery, with three automatic attempts total. There are no 30-second retry sleeps. Lost acknowledgements can cause duplicates; delivery is at least once. Acknowledged channels are not resent. Purchase completion and notification success are separate; inspect the outbox for exhausted attempts. `retry-notifications` restarts exhausted attempts without buying anything.

Schedules are removed after completion and delivery acknowledgement/exhaustion. They also have a hard end date covering recovery/delivery grace and automatic deletion. Only leases have DynamoDB TTL; jobs persist. Compressed checkpoints have a 350 KB safety limit. Failed checkpoint writes stop further purchases.

Scheduler target failures and failed asynchronous Lambda executions go to SQS. The included alarm has no external actions; connect existing monitoring if needed. Inspect the queue and saved status before manual recovery. Provider and notification failures appear in job status. AWS deployment/IAM, real Slack/email delivery, and purchase/configuration still need live acceptance testing after setup.

## Estimated cost

Planning estimate for US East (N. Virginia), USD, checked October 26, 2026. One full 24-hour request at five-minute intervals makes 288 rounds. Early completion costs less. Assumptions: 512 MB x86 Lambda averaging five seconds per round, 50 DynamoDB write units and 10 read units per round including transactions, one secret read per invocation, 1 KB logs per round, one secret, and one standard alarm. These are sizing assumptions, not measured usage.

| Full 24-hour requests per month | Poll rounds | Estimated AWS total/month |
| ---: | ---: | ---: |
| 10 | 2,880 | About $1 |
| 100 | 28,800 | About $3 |
| 1,000 | 288,000 | About $25 |

Includes roughly $0.50/month for one secret and alarm. Lambda and DynamoDB are charged before free allowances in these estimates. Scheduler fits its 14 million monthly free invocations, assuming that allowance is available. Small storage/failure-queue traffic are negligible at these volumes. Larger checkpoints, retries, pagination, more secrets, and accumulated storage change the bill. At 1,000 requests/month, averaging 30 seconds instead of five increases Lambda compute from about $12 to $72/month before free allowances. Measure actual duration before relying on the estimates.

Pricing basis: [Lambda](https://aws.amazon.com/lambda/pricing/) at $0.20/million requests and $0.0000166667/GB-second; [DynamoDB on-demand](https://aws.amazon.com/dynamodb/pricing/on-demand/) at $0.625/million write units and $0.125/million read units in this region; [Scheduler](https://aws.amazon.com/eventbridge/pricing/) at 14 million free invocations/month then $1/million; [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) at $0.40/secret/month and $0.05/10,000 calls; [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) for logs and the alarm. Verify region-specific rates before deploying.

Phone-number fees, monthly rental, carrier usage, taxes, and email provider fees are additional. Per-number quote ceilings are not an AWS spending cap or a lifetime limit on number billing.
