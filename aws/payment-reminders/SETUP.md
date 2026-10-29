# CashFlow Sentinel — payment reminders on AWS

This folder contains the reminder Lambda source, a test event and an IAM policy template. The app keeps the existing cash-flow API, Bedrock insights, analysis history, S3 CSV and SNS critical-alert design. Payment due emails use **Amazon SES directly to the email saved on each invoice** so invoice details are not broadcast to every subscriber of the critical-alert SNS topic.

## Existing AWS resources referenced
- Region: `ap-southeast-2` (Sydney)
- AWS account ID shown in the supplied console screenshots: `412433835611`
- DynamoDB payments table: `CashFlowPayments` with partition key `businessId` (String) and sort key `paymentId` (String)
- Reminder Lambda: `cashflow-sentinel-reminders`
- EventBridge Scheduler schedule: `cashflow-daily-payment-reminders` (rate: 1 day; timezone shown as `Asia/Calcutta`)
- Existing receipts bucket default: `cashflow-sentinel-pallavi-2026`
- Existing critical alert SNS topic remains separate: `cashflow-sentinel-alerts`

These names are based on the provided project/screenshots; verify they still match your AWS console before changing anything.

## A. Verify Amazon SES first
1. Open https://ap-southeast-2.console.aws.amazon.com/ses/home?region=ap-southeast-2#/account
2. In **Verified identities**, verify the sender email you control (for example, your own email). Open the SES verification email and click the verification link.
3. If SES is in its sandbox, it can only send to verified recipient addresses. Either verify each test recipient, or request production access in SES before sending to arbitrary invoice recipients.
4. Set Lambda environment variable `SES_FROM_EMAIL` to the exact verified sender address.

## B. Update the reminder Lambda code
1. Open https://ap-southeast-2.console.aws.amazon.com/lambda/home?region=ap-southeast-2#/functions/cashflow-sentinel-reminders
2. Runtime should be Node.js 20.x or newer. Create/update the function code from `index.mjs`. The Lambda console editor may not directly accept `.mjs` as an inline file; if necessary, package `index.mjs` and its dependencies into a ZIP and upload it. For Node.js ESM, use `index.mjs` as the handler file and set handler to `index.handler`.
3. Add environment variables:
   - `AWS_REGION` = `ap-southeast-2`
   - `PAYMENTS_TABLE` = `CashFlowPayments`
   - `SES_FROM_EMAIL` = your SES-verified sender email
4. Give the Lambda execution role the permissions from `iam-policy.json` plus the standard CloudWatch Logs permissions (`logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`). The policy template contains the account/table ARN from the screenshots; verify account ID before use.
5. Deploy the code.

### Package Lambda ZIP from the project folder (PowerShell)
Use a folder with `index.mjs` and dependencies. Install the AWS SDK packages into that folder before compressing if your Lambda runtime does not provide them:
```powershell
mkdir reminder-deploy
Copy-Item .\aws\payment-reminders\index.mjs .\reminder-deploy\index.mjs
Set-Location .\reminder-deploy
npm init -y
npm pkg set type=module
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-sesv2
Compress-Archive -Path * -DestinationPath ..\payment-reminders-lambda.zip -Force
```
Upload `payment-reminders-lambda.zip` in Lambda **Code → Upload from → .zip file**. Ensure `index.mjs` is at the ZIP root, not nested in another folder. Set handler to `index.handler`.

## C. Verify EventBridge Scheduler
1. Open https://ap-southeast-2.console.aws.amazon.com/scheduler/home?region=ap-southeast-2#schedules
2. Open `cashflow-daily-payment-reminders`; confirm **Enabled**, target is `cashflow-sentinel-reminders`, and schedule is `rate(1 day)`.
3. Check the target execution role lets EventBridge invoke this Lambda (`lambda:InvokeFunction` on the reminder function). If the schedule is already enabled and targets this function, do not create a duplicate schedule.
4. The schedule runs once daily. It continues while your laptop is off.

## D. Payment table schema
`CashFlowPayments` must use:
- Partition key: `businessId` — String
- Sort key: `paymentId` — String

Each item should include `businessName`, `recipientEmail`, `invoiceId`, `description`, `dueDate` (`YYYY-MM-DD`), `totalAmount` (Number), `amountPaid` (Number), `amountDue` (Number), `status` (`UNPAID`, `PARTIALLY_PAID`, `PAID`), and optional `reminderStartDays` (defaults to 7). The app creates these fields through `/api/payments`.

## E. Test safely
1. In Lambda, use the test event in `test-event.json`:
   ```json
   { "action": "check-payment-reminders" }
   ```
2. Check the response and CloudWatch logs for `scanned`, `sent`, `skipped`, and `errors`.
3. A record is skipped when it is fully paid, missing required fields, outside the reminder window, or already reminded in the applicable period.
4. Upcoming reminders send once per day from `reminderStartDays` before the due date through the due date. Overdue reminders send no more often than every seven days.
5. Verify the email recipient inbox and spam folder. A successful Lambda response means SES accepted the send request, not guaranteed inbox delivery.

## F. Local app configuration
Copy `.env.example` to `.env`, then set `SES_FROM_EMAIL` to the verified sender. Keep AWS credentials out of the ZIP/GitHub. With AWS CLI configured, the local IAM identity needs `dynamodb:Scan`, `dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:UpdateItem` on `CashFlowPayments`, `s3:PutObject` on `payment-receipts/*`, and `ses:SendEmail`. The reminder Lambda has its own execution role; local laptop permissions do not carry over to Lambda.

## Security notes
- Payment receipts are uploaded to S3 with server-side AES256 encryption; this app stores receipt object keys and metadata, not public URLs. Keep the bucket private and enable Block Public Access.
- This project is still a prototype. Before real customer use, add server-side authentication/session management and enforce business-level access on every payment API. Do not rely on a user-supplied `businessId` as authorization.
- SES sender verification and delivery configuration are required. Existing SNS critical alerts remain separate and are not used to broadcast payment/invoice details.
