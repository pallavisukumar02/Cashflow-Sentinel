
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0";

const bedrock = new BedrockRuntimeClient({ region: REGION });

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
};

function response(statusCode, data) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(data),
  };
}

function parseBody(event) {
  if (!event?.body) return {};
  if (typeof event.body === "object") return event.body;

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  return JSON.parse(raw);
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function money(value) {
  return Math.round(value * 100) / 100;
}

function validDate(value, fieldName) {
  const date = new Date(value);

  if (!value || Number.isNaN(date.getTime())) {
    throw new Error(`Please provide a valid ${fieldName}. Use YYYY-MM-DD.`);
  }

  return date;
}

// FEATURE 1: AI WHAT-IF CASH-FLOW SIMULATOR
export function simulateCashflow(data = {}) {
  const initialCash = number(data.initialCash, NaN);
  const expectedReceivables = number(data.expectedReceivables, NaN);
  const dailyOutflow = number(data.dailyOutflow, NaN);
  const daysLate = number(data.daysLate, NaN);

  if (
    !Number.isFinite(initialCash) ||
    !Number.isFinite(expectedReceivables) ||
    !Number.isFinite(dailyOutflow) ||
    !Number.isFinite(daysLate) ||
    initialCash < 0 ||
    expectedReceivables < 0 ||
    dailyOutflow < 0 ||
    daysLate < 0
  ) {
    throw new Error(
      "Provide non-negative initialCash, expectedReceivables, dailyOutflow, and daysLate."
    );
  }

  const cashWithoutDelay =
    initialCash + expectedReceivables - dailyOutflow * daysLate;

  const cashWithDelay = initialCash - dailyOutflow * daysLate;

  return {
    feature: "what_if_simulator",
    currency: data.currency || "INR",
    daysLate,
    cashWithoutDelay: money(cashWithoutDelay),
    cashWithDelay: money(cashWithDelay),
    cashImpact: money(cashWithDelay - cashWithoutDelay),
    projectedShortfall: money(Math.max(0, -cashWithDelay)),
    explanation:
      "This simplified scenario assumes the receivable arrives after the delay period and daily outflows continue unchanged. Replace estimates with actual business data before making decisions.",
  };
}

// FEATURE 2: CUSTOMER PAYMENT RELIABILITY
export function analyzePaymentReliability(data = {}) {
  const invoices = data.invoices;

  if (!Array.isArray(invoices) || invoices.length === 0) {
    throw new Error(
      "Provide invoices as a non-empty array with customer, dueDate, and paidDate."
    );
  }

  const groups = {};

  for (const invoice of invoices) {
    if (!invoice.customer || !invoice.dueDate || !invoice.paidDate) {
      throw new Error(
        "Each invoice needs customer, dueDate, and paidDate."
      );
    }

    const due = validDate(invoice.dueDate, "dueDate");
    const paid = validDate(invoice.paidDate, "paidDate");

    const lateDays = Math.max(
      0,
      Math.ceil((paid.getTime() - due.getTime()) / 86400000)
    );

    if (!groups[invoice.customer]) {
      groups[invoice.customer] = {
        customer: invoice.customer,
        invoiceCount: 0,
        lateInvoiceCount: 0,
        totalLateDays: 0,
      };
    }

    const group = groups[invoice.customer];
    group.invoiceCount += 1;
    group.totalLateDays += lateDays;

    if (lateDays > 0) group.lateInvoiceCount += 1;
  }

  const customers = Object.values(groups).map((group) => {
    const averageLateDays =
      group.totalLateDays / group.invoiceCount;

    const lateRate =
      group.lateInvoiceCount / group.invoiceCount;

    // A simple, transparent heuristic, not a credit rating.
    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(100 - lateRate * 70 - averageLateDays * 2)
      )
    );

    return {
      customer: group.customer,
      invoiceCount: group.invoiceCount,
      lateInvoiceCount: group.lateInvoiceCount,
      averageLateDays: money(averageLateDays),
      reliabilityScore: score,
      category:
        score >= 80
          ? "Reliable"
          : score >= 60
            ? "Moderate risk"
            : "Needs attention",
    };
  });

  return {
    feature: "payment_reliability",
    scoringNote:
      "This is a simple heuristic based only on the supplied paid invoices. It is not a credit score or a prediction of future payment.",
    customers,
  };
}

// FEATURE 3: SMART PAYMENT PRIORITIZER
export function prioritizePayments(data = {}) {
  const availableCash = number(data.availableCash, NaN);
  const payments = data.payments;

  if (!Number.isFinite(availableCash) || availableCash < 0) {
    throw new Error("Provide a non-negative availableCash amount.");
  }

  if (!Array.isArray(payments) || payments.length === 0) {
    throw new Error(
      "Provide payments as a non-empty array with name, amount, and dueDate."
    );
  }

  const today = data.asOfDate
    ? validDate(data.asOfDate, "asOfDate")
    : new Date();

  today.setHours(0, 0, 0, 0);

  const ranked = payments.map((payment) => {
    if (!payment.name || !payment.dueDate) {
      throw new Error("Each payment needs name and dueDate.");
    }

    const amount = number(payment.amount, NaN);

    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(
        `Payment "${payment.name}" needs a non-negative amount.`
      );
    }

    const due = validDate(payment.dueDate, "dueDate");
    due.setHours(0, 0, 0, 0);

    const daysUntilDue = Math.ceil(
      (due.getTime() - today.getTime()) / 86400000
    );

    const penalty = Math.max(0, number(payment.penalty, 0));
    const importance = Math.max(
      1,
      Math.min(5, number(payment.importance, 3))
    );

    const overdueUrgency = daysUntilDue < 0 ? 100 : 0;
    const dueUrgency =
      daysUntilDue <= 0
        ? 50
        : Math.max(0, 30 - daysUntilDue);

    const priorityScore =
      overdueUrgency +
      dueUrgency +
      Math.min(40, penalty / Math.max(amount, 1) * 100) +
      importance * 5;

    return {
      name: payment.name,
      amount: money(amount),
      dueDate: due.toISOString().slice(0, 10),
      daysUntilDue,
      penalty: money(penalty),
      importance,
      priorityScore: money(priorityScore),
    };
  });

  ranked.sort(
    (a, b) =>
      b.priorityScore - a.priorityScore ||
      a.daysUntilDue - b.daysUntilDue
  );

  let remainingCash = availableCash;

  const prioritized = ranked.map((payment) => {
    const canPay = payment.amount <= remainingCash;

    if (canPay) remainingCash -= payment.amount;

    return {
      ...payment,
      recommendation: canPay
        ? "Fits within the remaining cash budget"
        : "Insufficient remaining cash; review before paying",
      fitsAvailableCash: canPay,
    };
  });

  return {
    feature: "payment_prioritizer",
    currency: data.currency || "INR",
    availableCash: money(availableCash),
    remainingCash: money(remainingCash),
    payments: prioritized,
    scoringNote:
      "Priority scores are heuristic recommendations, not payment instructions. Verify contractual due dates, legal obligations, and business-critical payments before acting.",
  };
}

async function askBedrock(question, context = {}) {
  const systemPrompt = `
You are Cashflow Sentinel, a financial operations copilot for businesses.

Help users understand cash flow, customer payment behavior, and payment planning.
Explain assumptions and distinguish estimates from verified facts.
Never invent business figures or claim to have accessed financial systems.
Ask for missing figures when a calculation requires them.
Do not claim that an email alert was sent or a payment was made.
This is decision support, not professional financial advice.
`;

  const userMessage = [
    question,
    Object.keys(context).length
      ? `\nSupplied business data:\n${JSON.stringify(context)}`
      : "",
  ].join("");

  const command = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: systemPrompt }],
    messages: [
      {
        role: "user",
        content: [{ text: userMessage }],
      },
    ],
    inferenceConfig: {
      maxTokens: 700,
      temperature: 0.2,
    },
  });

  const result = await bedrock.send(command);

  const answer = (result.output?.message?.content || [])
    .filter((block) => typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!answer) {
    throw new Error("Amazon Bedrock returned an empty answer.");
  }

  return answer;
}

export const handler = async (event = {}) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod;

  if (method === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  try {
    const body = parseBody(event);
    const question =
      typeof body.question === "string" ? body.question.trim() : "";

    const feature =
      typeof body.feature === "string"
        ? body.feature.trim().toLowerCase()
        : "";

    if (!question && !feature) {
      return response(400, {
        error: "Provide a question or a feature.",
      });
    }

    if (feature === "simulate" || feature === "what_if_simulator") {
      return response(200, simulateCashflow(body.data || body));
    }

    if (
      feature === "reliability" ||
      feature === "payment_reliability"
    ) {
      return response(
        200,
        analyzePaymentReliability(body.data || body)
      );
    }

    if (
      feature === "prioritize" ||
      feature === "payment_prioritizer"
    ) {
      return response(200, prioritizePayments(body.data || body));
    }

    const answer = await askBedrock(question, body.context || {});

    return response(200, {
      answer,
      model: MODEL_ID,
      region: REGION,
    });
  } catch (error) {
    console.error("Cashflow Sentinel backend error:", {
      name: error?.name,
      message: error?.message,
      metadata: error?.$metadata,
    });

    const name = error?.name || "";
    const message = error?.message || "Unexpected backend error.";

    let statusCode = 500;
    let explanation =
      "The request failed. Check the backend terminal logs for details.";

    if (
      name.includes("Credentials") ||
      name === "UnrecognizedClientException"
    ) {
      statusCode = 503;
      explanation =
        "AWS credentials are missing or invalid. Configure AWS credentials for the environment running this backend.";
    } else if (
      name === "AccessDeniedException" ||
      name === "UnauthorizedException"
    ) {
      statusCode = 403;
      explanation =
        "AWS denied access. Check IAM permissions and Amazon Bedrock model access in the configured region.";
    } else if (
      name === "ResourceNotFoundException" ||
      name === "ValidationException"
    ) {
      statusCode = 400;
      explanation =
        "Bedrock could not accept the model request. Check the model ID, region, and request configuration.";
    } else if (message.includes("Provide ") || message.includes("Each ")) {
      statusCode = 400;
      explanation = message;
    }

    return response(statusCode, {
      error: explanation,
      code: name || "BackendError",
      model: MODEL_ID,
      region: REGION,
    });
  }
};
