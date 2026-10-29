# Public deployment and AI Copilot

## Run locally
1. Use Node.js 20 or newer.
2. In this folder run `npm install`.
3. Copy `.env.example` to `.env` and set the AWS values needed by the features you use.
4. Run `npm start`, then open `http://localhost:3000`.

## Deploy a public HTTPS URL with Render
1. Put the contents of this folder in a private GitHub repository. Do not commit `.env`, AWS keys, or user data.
2. In Render, choose **New > Blueprint** and connect the repository; Render reads `render.yaml`.
3. In the Render service's Environment settings, add AWS credentials or (preferably) use an AWS role/secure credential broker. Set `SES_FROM_EMAIL` to a verified SES sender. Never place AWS keys in frontend JavaScript or public repositories.
4. Ensure IAM permissions cover only the needed resources: Bedrock Converse, DynamoDB table operations, S3 object access, and SES send operations.
5. Deploy and check `/health`. Render will give you the public HTTPS URL.

## Important limits
- A public URL is not created by packaging the ZIP; someone must deploy it to a hosting account. This repo includes a Render blueprint, but the deployment must be run in your account.
- If your AWS account cannot safely provide AWS credentials to the hosting environment, use an AWS-hosted deployment or a secured backend role rather than exposing credentials.
- The Copilot uses Amazon Bedrock via `BEDROCK_MODEL_ID` in `AWS_REGION`; model access and IAM permissions must be enabled.
- Email sending needs a verified SES sender. If SES is in sandbox, recipients also need to be verified.
- EventBridge Scheduler runs separately from the website and invokes the configured reminder Lambda. Keep the schedule enabled and ensure it targets the correct Lambda. The dashboard does not create or change the schedule.
- Browser sound alerts work only while the dashboard is open and after browser interaction; SNS/SES email alerts are server-side.
- Demo financial values are for testing. Confirm CSV mapping and invoice emails before importing live records.
