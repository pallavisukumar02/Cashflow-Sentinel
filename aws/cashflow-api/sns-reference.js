
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const sns = new SNSClient({});

const TOPIC_ARN = process.env.SNS_TOPIC_ARN;

export async function sendCashflowAlert({
  businessName = "Demo MSME",
  alert = "Cash balance is approaching the minimum safety threshold.",
  action = "Review upcoming supplier payments and customer receivables.",
  status = "Cashflow Sentinel alert",
} = {}) {
  if (!TOPIC_ARN) {
    throw new Error(
      "Missing required environment variable: SNS_TOPIC_ARN"
    );
  }

  const message = [
    "Cashflow Sentinel Alert",
    "",
    `Business: ${businessName}`,
    "",
    `Alert: ${alert}`,
    "",
    `Recommended action: ${action}`,
    "",
    `Status: ${status}`,
  ].join("\n");

  const response = await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: `Cashflow Sentinel Alert - ${businessName}`.slice(0, 100),
      Message: message,
    })
  );

  return {
    messageId: response.MessageId,
    topicArn: TOPIC_ARN,
  };
}
