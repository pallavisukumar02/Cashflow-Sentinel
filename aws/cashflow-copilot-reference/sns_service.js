
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const sns = new SNSClient({
  region: process.env.AWS_REGION || "ap-southeast-2",
});

const TOPIC_ARN =
  process.env.SNS_TOPIC_ARN ||
  "arn:aws:sns:ap-southeast-2:998116077048:CashflowSentinelAlerts";

export async function sendCashflowAlert({
  businessName,
  alert,
  action,
}) {
  if (!businessName || !alert || !action) {
    throw new Error(
      "businessName, alert, and action are required."
    );
  }

  const message = [
    "Cashflow Sentinel Alert",
    "",
    `Business: ${businessName}`,
    "",
    `Alert: ${alert}`,
    "",
    `Recommended Action: ${action}`,
  ].join("\n");

  const result = await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: `Cashflow Sentinel Alert - ${businessName}`,
      Message: message,
    })
  );

  console.log("SNS alert published:", result.MessageId);

  return {
    success: true,
    messageId: result.MessageId,
  };
}
