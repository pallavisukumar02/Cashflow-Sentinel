
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import {
  DynamoDBDocumentClient,
  PutCommand
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  ConverseCommand
} from "@aws-sdk/client-bedrock-runtime";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sns = new SNSClient({
  region: process.env.AWS_REGION || "ap-southeast-2"
});
const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "ap-southeast-2"
});

const TABLE_NAME = "CashFlowAnalyses";
const BUCKET = "cashflow-sentinel-pallavi-2026";
const KEY = "sample-transaction.csv";
const MODEL_ID = "amazon.nova-lite-v1:0";

const respond = (statusCode, data) => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  },
  body: JSON.stringify(data)
});

// Generate an AI explanation without allowing an AI failure
// to break the core financial calculation.
async function addAIInsights(result) {
  try {
    const prompt = `
You are a financial assistant for small businesses.
Explain the cash-flow analysis in plain, practical language.

Use only the data supplied below. Do not invent facts,
dates, interest rates, or financial transactions.
Do not claim to be a certified financial adviser.
Keep the explanation concise and give up to three practical actions.
The calculated financial status and amounts must not be changed.

Analysis:
${JSON.stringify({
  currency: result.currency,
  currentCash: result.currentCash,
  expectedIncome: result.expectedIncome,
  receivables: result.receivables,
  expectedExpenses: result.expectedExpenses,
  upcomingObligations: result.upcomingObligations,
  projectedCash: result.projectedCash,
  financialStatus: result.financialStatus,
  warnings: result.warnings,
  existingRecommendation: result.recommendation
})}

Return:
1. summary: a short explanation of the financial position.
2. risks: the main cash-flow concern.
3. actions: practical next steps.
`;

    const response = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        messages: [
          {
            role: "user",
            content: [{ text: prompt }]
          }
        ],
        inferenceConfig: {
          maxTokens: 700,
          temperature: 0.2
        }
      })
    );

    const aiInsight = (response.output?.message?.content || [])
      .map(item => item.text || "")
      .join("")
      .trim();

    return {
      ...result,
      aiInsight: aiInsight || "The AI returned an empty response.",
      aiProvider: "Amazon Bedrock",
      aiModel: MODEL_ID,
      aiStatus: aiInsight ? "success" : "empty_response"
    };
  } catch (error) {
    console.error("Bedrock invocation failed:", error.name, error.message);

    return {
      ...result,
      aiInsight: null,
      aiProvider: "Amazon Bedrock",
      aiStatus: "unavailable",
      aiError: error.message,
      aiNote: "Financial calculations are available; AI insights could not be generated."
    };
  }
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error("CSV has no transaction rows.");
  }

  const headers = lines[0]
    .replace(/^\uFEFF/, "")
    .split(",")
    .map(x => x.trim().toLowerCase());

  for (const field of ["date", "description", "amount", "type"]) {
    if (!headers.includes(field)) {
      throw new Error(`CSV is missing column: ${field}`);
    }
  }

  return lines.slice(1).map(line => {
    const cells = line.split(",");
    const row = {};
    headers.forEach((header, i) => {
      row[header] = (cells[i] || "").trim();
    });
    return row;
  });
}

async function saveResult(result) {
  await db.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: result
  }));
}

async function sendCashflowAlert(result) {
  // Financial analysis uses financialStatus (not status).
  if (result.financialStatus !== "CRITICAL") {
    return { sent: false, reason: "Status is not CRITICAL" };
  }

  const topicArn = process.env.SNS_TOPIC_ARN;
  if (!topicArn) {
    console.error("SNS_TOPIC_ARN is not configured");
    return { sent: false, reason: "SNS topic not configured" };
  }

  try {
    const response = await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Subject: "CashFlow Sentinel - Critical Alert",
        Message: [
          "CASHFLOW SENTINEL ALERT",
          "",
          `Business: ${result.businessName || result.businessId || "MSME"}`,
          `Status: ${result.financialStatus}`,
          `Projected cash: ${result.currency || "INR"} ${result.projectedCash}`,
          "",
          `Recommendation: ${result.recommendation || "Review upcoming expenses and collect overdue receivables."}`,
          "",
          `Analysis ID: ${result.analysisId}`,
          `Created at: ${result.createdAt}`
        ].join("\n")
      })
    );

    return { sent: true, messageId: response.MessageId };
  } catch (error) {
    // Notifications must not fail the analysis or prevent DynamoDB saving.
    console.error("SNS alert failed:", error.name, error.message);
    return { sent: false, reason: "SNS publish failed" };
  }
}


async function analyzeCSV(event) {
  const input = JSON.parse(event.body || "{}");
  const currentCash = Number(input.currentCash ?? 0);
  const obligations = Number(input.upcomingObligations ?? 0);

  if (![currentCash, obligations].every(
    x => Number.isFinite(x) && x >= 0
  )) {
    return respond(400, {
      error: "currentCash and upcomingObligations must be non-negative numbers."
    });
  }

  const object = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: KEY
  }));

  const csv = await object.Body.transformToString("utf-8");
  const transactions = parseCSV(csv);

  let income = 0;
  let expenses = 0;
  let skippedRows = 0;

  for (const tx of transactions) {
    const amount = Number(
      tx.amount.replace(/[₹,\s]/g, "")
    );
    const type = tx.type.toLowerCase();

    if (!Number.isFinite(amount) || amount < 0) {
      skippedRows++;
      continue;
    }

    if (["income", "credit", "inflow", "received", "sale"].includes(type)) {
      income += amount;
    } else if (
      ["expense", "debit", "outflow", "payment", "purchase"].includes(type)
    ) {
      expenses += amount;
    } else {
      skippedRows++;
    }
  }

  if (income === 0 && expenses === 0) {
    throw new Error("No recognized transactions. Check the CSV type column.");
  }

  const projectedCash = currentCash + income - expenses - obligations;

  const financialStatus = projectedCash < 0
    ? "CRITICAL"
    : projectedCash < expenses * 0.25
      ? "WARNING"
      : "HEALTHY";

  const result = {
    application: "CashFlow Sentinel",
    businessId: String(input.businessId || "demo-business"),
    analysisId: randomUUID(),
    createdAt: new Date().toISOString(),
    currency: input.currency || "INR",
    source: `s3://${BUCKET}/${KEY}`,
    transactionCount: transactions.length,
    skippedRows,
    currentCash,
    expectedIncome: income,
    receivables: 0,
    expectedExpenses: expenses,
    upcomingObligations: obligations,
    projectedCash,
    financialStatus,
    warnings: projectedCash < 0
      ? ["Projected cash deficit: outflows exceed available funds."]
      : financialStatus === "WARNING"
        ? ["Low projected cash buffer."]
        : [],
    recommendation: projectedCash < 0
      ? "Review spending, follow up on customer payments, and discuss payment extensions."
      : financialStatus === "WARNING"
        ? "Build a cash buffer and confirm incoming payments."
        : "Continue monitoring transactions and upcoming obligations."
  };

  const enriched = await addAIInsights(result);
  await saveResult(enriched);

  // SNS is attempted after the analysis is safely saved. Alert failures are non-fatal.
  const alert = await sendCashflowAlert(enriched);
  return respond(200, { ...enriched, alert });
}

export const handler = async event => {
  try {
    const method = event?.requestContext?.http?.method || "GET";
    const path = event?.rawPath || "/health";

    if (method === "OPTIONS") {
      return respond(200, { message: "OK" });
    }

    if (method === "GET" && path === "/health") {
      return respond(200, {
        status: "ok",
        application: "CashFlow Sentinel",
        message: "API is running",
        bedrockModel: MODEL_ID
      });
    }

    if (method === "POST" && path === "/analyze-csv") {
      return await analyzeCSV(event);
    }

    if (method === "POST" && path === "/analyze") {
      const input = JSON.parse(event.body || "{}");

      const cash = Number(input.currentCash);
      const income = Number(input.expectedIncome);
      const expenses = Number(input.expectedExpenses);
      const receivables = Number(input.receivables ?? 0);
      const obligations = Number(input.upcomingObligations ?? 0);

      if (
        ["currentCash", "expectedIncome", "expectedExpenses"].some(
          key => input[key] === undefined || input[key] === ""
        ) ||
        [cash, income, expenses, receivables, obligations].some(
          x => !Number.isFinite(x) || x < 0
        )
      ) {
        return respond(400, {
          error: "Enter valid, non-negative financial amounts."
        });
      }

      const projectedCash =
        cash + income + receivables - expenses - obligations;

      const financialStatus = projectedCash < 0
        ? "CRITICAL"
        : projectedCash < expenses * 0.25
          ? "WARNING"
          : "HEALTHY";

      const result = {
        application: "CashFlow Sentinel",
        businessId: String(input.businessId || "demo-business"),
        analysisId: randomUUID(),
        createdAt: new Date().toISOString(),
        currency: input.currency || "INR",
        currentCash: cash,
        expectedIncome: income,
        receivables,
        expectedExpenses: expenses,
        upcomingObligations: obligations,
        projectedCash,
        financialStatus,
        warnings: projectedCash < 0
          ? ["Projected cash deficit: expected outflows exceed available funds."]
          : financialStatus === "WARNING"
            ? ["Low cash buffer."]
            : [],
        recommendation: projectedCash < 0
          ? "Review spending, follow up on invoices, and discuss payment extensions."
          : financialStatus === "WARNING"
            ? "Build a cash buffer and confirm incoming payments."
            : "Continue monitoring payment timing and obligations."
      };

      const enriched = await addAIInsights(result);
      await saveResult(enriched);

      // SNS is attempted after the analysis is safely saved. Alert failures are non-fatal.
      const alert = await sendCashflowAlert(enriched);
      return respond(200, { ...enriched, alert });
    }

    return respond(404, {
      error: "Route not found",
      availableRoutes: [
        "GET /health",
        "POST /analyze",
        "POST /analyze-csv"
      ]
    });
  } catch (error) {
    console.error("CashFlow Sentinel error:", error);

    return respond(500, {
      error: "Analysis failed. Check the Lambda CloudWatch logs.",
      detail: error.message,
      requestId: event?.requestContext?.requestId
    });
  }
};
