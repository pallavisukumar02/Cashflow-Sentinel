# AWS resources bundled with CashFlow Sentinel

- `cashflow-api/index.mjs`: existing cash-flow analysis Lambda source (Bedrock + DynamoDB + S3 CSV + SNS critical alerts) supplied with the project.
- `payment-reminders/index.mjs`: daily payment reminder Lambda source, using SES to send invoice-specific email directly to `recipientEmail`.
- `payment-reminders/iam-policy.json`: IAM policy template for the reminder Lambda role.
- `payment-reminders/test-event.json`: Lambda test payload.
- `payment-reminders/SETUP.md`: deployment and verification guide.

The files are source and setup assets. Extracting the ZIP does not deploy code or create/update AWS resources. Follow the setup guide in the AWS console, and keep the existing critical-alert Lambda separate from the reminder Lambda.
