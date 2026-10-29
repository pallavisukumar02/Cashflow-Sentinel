# CashFlow Sentinel — VS Code Ready

A full-stack MSME cash-flow health dashboard. The frontend is served by Express, so **you do not need a separate frontend dev server**. This fixes the earlier `Cannot GET /` issue: visit the root URL `http://localhost:3000/`, not a different port.

## Requirements
- Node.js 20 or newer
- VS Code
- AWS access configured locally only if you want S3/DynamoDB operations. The dashboard's calculation endpoint can still run locally if AWS permissions are not configured.

## 1. Open and install
1. Extract this ZIP.
2. In VS Code, open the extracted `cashflow-sentinel-ready` folder (the folder containing `package.json`).
3. Open **Terminal → New Terminal**.
4. Run:

   ```powershell
   npm install
   Copy-Item .env.example .env
   ```

5. Start the app:

   ```powershell
   npm start
   ```

6. Open **http://localhost:3000/**. Keep the terminal running while you use the app.
7. Test backend health at **http://localhost:3000/health**. It should return JSON with `"status":"ok"`.

> Do not type `node server.js` from the project root. The server is `backend/server.js`, and `npm start` runs the correct file.

## 2. AWS resources already configured in this project
- Region: `ap-southeast-2` (Asia Pacific — Sydney)
- HTTP API Gateway base URL: `https://1qi4kyk8ak.execute-api.ap-southeast-2.amazonaws.com`
- Lambda: `cashflow-sentinel-api`
- S3 bucket: `cashflow-sentinel-pallavi-2026`
- Default S3 object: `sample-transaction.csv`
- DynamoDB table: `CashFlowAnalyses`

These are configuration values, not credentials. No AWS access key or secret is embedded in this project.

## 3. AWS authentication for local development
Recommended: use AWS CLI credentials / profile. If AWS CLI is installed and configured, `.env` uses `AWS_PROFILE=default`. Otherwise the AWS SDK default credential provider chain must find valid credentials.

Check from PowerShell:
```powershell
aws sts get-caller-identity
```
If the command is not found, install AWS CLI v2 and configure credentials, or skip cloud operations until you can configure it. Do not paste access keys into chat or commit `.env`.

The IAM identity used locally needs:
- DynamoDB: `dynamodb:PutItem` and `dynamodb:Scan` on `arn:aws:dynamodb:ap-southeast-2:412433835611:table/CashFlowAnalyses`
- S3: `s3:GetObject` on `arn:aws:s3:::cashflow-sentinel-pallavi-2026/*`
- Optional if adding CSV uploads to S3 later: `s3:PutObject` on the bucket object ARN.

Your Lambda's execution role and your local AWS CLI identity are separate. A permission attached to the Lambda role does not automatically grant your laptop access.

## 4. What works
- Dashboard at `/`
- Health check at `/health`
- Cash-flow calculation at `POST /api/analyze`
- Attempts to save every analysis to DynamoDB and displays whether saving succeeded
- Recent analysis history via DynamoDB Scan
- CSV upload and analysis from the browser
- Read the configured sample CSV from S3
- Cash status rules: CRITICAL if projected cash is negative; WARNING if projected cash is less than 25% of expected expenses; otherwise HEALTHY.

## 5. CSV format
The parser looks for an amount column named `amount`, `transaction_amount`, `value`, or `transaction_value`. It optionally uses a type column such as `type` or `transaction_type`; types containing `income`, `credit`, `sales`, etc. are counted as income, and types containing `expense`, `debit`, `payment`, etc. are counted as expenses. If no type column exists, positive amounts are treated as income and negative amounts as expenses. Check the CSV analysis note because real bank CSV schemas vary.

## 6. Existing API Gateway / Lambda
The configured API Gateway URL is retained in `.env` as `AWS_API_BASE_URL` for future cloud integration. The local dashboard calls its local Express backend. That keeps UI testing independent of API Gateway and makes error messages easier to debug. The local `/api/analyze` endpoint currently runs the same rule-based logic and writes directly to DynamoDB; it does not invoke the API Gateway URL.

## Troubleshooting
- **Cannot GET /**: make sure you ran `npm start` in the project root, then open `http://localhost:3000/`. Do not open `localhost:3000` unless the terminal says the server is running.
- **ECONNREFUSED**: server is not running; start `npm start`.
- **DynamoDB AccessDenied**: configure local AWS credentials and grant the local identity `PutItem` and `Scan`. The Lambda role's policy is separate.
- **S3 AccessDenied / NoSuchKey**: verify bucket/object spelling, region, and local IAM permissions. You can upload a CSV directly to avoid S3 reading.
- **Port already in use**: change `PORT=3001` in `.env` and open `http://localhost:3001/`.

## Safety note
This is a hackathon MVP and a rule-based planning aid, not a regulated financial advisory product. Do not upload real customer financial records without permission and appropriate safeguards.


## Account flow and payment-risk chart (updated)

- The app opens on the CashFlow Sentinel landing page. **Let's get started** opens sign-up.
- Sign-up saves the account to `backend/data/users.json` and then redirects to the sign-in page. Passwords are stored as salted scrypt hashes, not plain text.
- After sign-in, users reach a feature-selection page with Cash-flow Analysis, Transaction CSV, Analysis History, and Risk Dashboard options.
- The dashboard includes a payment-risk snapshot comparing projected available funds (current cash + expected income + receivables) against payments due (expected expenses + upcoming obligations). The shortfall percentage is a simple planning indicator, not a credit-risk model.
- User accounts are stored locally on the server in this MVP. They are **not** stored in DynamoDB; DynamoDB continues to store analysis records. Back up `backend/data/users.json` if you need to preserve local accounts.

## 7. Payment due reminders and receipts (added)
- Open **Payment reminders** from the feature-selection screen or visit `http://localhost:3000/payments.html`.
- Create invoices with a due date, total, amount already paid and the email address that should receive reminders.
- Record partial/final payments and upload PDF/JPG/PNG/WEBP receipt metadata/files to S3.
- The app API uses the existing `CashFlowPayments` table. Reminder scheduling is performed by AWS Lambda `cashflow-sentinel-reminders` and EventBridge Scheduler `cashflow-daily-payment-reminders`, not by your laptop.
- Upcoming reminders are daily from the configured number of days before due date through the due date. Overdue reminders are weekly. Fully paid invoices are skipped.
- Direct per-invoice emails use Amazon SES, not the SNS topic, to avoid sending one customer's invoice details to every SNS subscriber. Verify a sender in SES and configure `SES_FROM_EMAIL` before sending.
- Follow `aws/payment-reminders/SETUP.md` for the AWS deployment, IAM, SES and test steps. The AWS console resources must be updated with the included Lambda code for the behavior described here to run; the ZIP alone does not change resources in your AWS account.

### Payment API endpoints
- `GET /api/payments?businessId=demo-business`
- `POST /api/payments`
- `POST /api/payments/:paymentId/record-payment`
- `POST /api/payments/:paymentId/receipt` (multipart field `receipt`)
- `POST /api/payments/:paymentId/test-reminder`

The payment page/API is an MVP and does not yet provide production-grade account isolation. Do not use it for real customer financial data until server-side authentication and per-business authorization are implemented.


## AI Copilot integration
The AI Copilot is available in the main dashboard sidebar. It calls `/api/copilot` on the backend, which invokes Amazon Bedrock using server-side AWS credentials. Configure `BEDROCK_MODEL_ID` and `AWS_REGION`; the hosting identity needs `bedrock:InvokeModel` permissions for the selected model. Original supplied chatbot source is retained under `aws/cashflow-copilot-reference/` for reference.

For a public HTTPS deployment, follow `PUBLIC-DEPLOYMENT.md` and the included `render.yaml`. A public URL is created only after you deploy this project in your own hosting account.
