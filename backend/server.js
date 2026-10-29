require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { randomUUID, randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("csv-parse/sync");
const {
  S3Client, GetObjectCommand, PutObjectCommand
} = require("@aws-sdk/client-s3");
const {
  DynamoDBClient
} = require("@aws-sdk/client-dynamodb");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const { BedrockRuntimeClient, ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");
const {
  DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand, UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const REGION = process.env.AWS_REGION || "ap-southeast-2";
const TABLE_NAME = process.env.DDB_TABLE || "CashFlowAnalyses";
const BUCKET = process.env.S3_BUCKET || "cashflow-sentinel-pallavi-2026";
const DEFAULT_KEY = process.env.S3_KEY || "sample-transaction.csv";
const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || "CashFlowPayments";
const RECEIPTS_BUCKET = process.env.RECEIPTS_BUCKET || BUCKET;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || "";
const ses = new SESv2Client({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0";
const AWS_API_BASE_URL = (process.env.AWS_API_BASE_URL || "").replace(/\/$/, "");
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
const readUsers = () => JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
const writeUsers = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
const hashPassword = (password, salt = randomBytes(16).toString("hex")) => ({ salt, hash: scryptSync(password, salt, 64).toString("hex") });
const verifyPassword = (password, user) => { const candidate = scryptSync(password, user.passwordSalt, 64); const stored = Buffer.from(user.passwordHash, "hex"); return stored.length === candidate.length && timingSafeEqual(candidate, stored); };

const s3 = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(require("node:path").join(__dirname, "public")));

function analyze(input) {
  const required = ["currentCash", "expectedIncome", "expectedExpenses"];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      const err = new Error(`Missing required field: ${key}`);
      err.status = 400;
      throw err;
    }
  }
  const cash = Number(input.currentCash);
  const income = Number(input.expectedIncome);
  const expenses = Number(input.expectedExpenses);
  const receivables = Number(input.receivables ?? 0);
  const obligations = Number(input.upcomingObligations ?? 0);
  if ([cash, income, expenses, receivables, obligations].some(v => !Number.isFinite(v) || v < 0)) {
    const err = new Error("Enter valid, non-negative financial amounts.");
    err.status = 400;
    throw err;
  }

  const projectedCash = cash + income + receivables - expenses - obligations;
  const warnings = [];
  if (projectedCash < 0) warnings.push("Projected cash deficit: expected outflows exceed available funds.");
  else if (projectedCash < expenses * 0.25) warnings.push("Low cash buffer: funds may be insufficient for unexpected costs.");
  if (receivables > 0) warnings.push("Confirm expected customer payment dates before relying on receivables.");

  const financialStatus = projectedCash < 0 ? "CRITICAL" : projectedCash < expenses * 0.25 ? "WARNING" : "HEALTHY";
  const recommendation = financialStatus === "CRITICAL"
    ? "Review discretionary spending, follow up on overdue invoices, and discuss payment extensions with creditors."
    : financialStatus === "WARNING"
      ? "Build a cash buffer and confirm incoming payments before committing to additional expenses."
      : "Continue monitoring payment timing and upcoming obligations.";

  return {
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
    warnings,
    recommendation
  };
}

async function saveAnalysis(result) {
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: { ...result, businessId: result.businessId, analysisId: result.analysisId }
  }));
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

app.post("/api/signup", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!name || !phone || !email || password.length < 8) return res.status(400).json({ error: "Enter your name, phone, valid email and a password with at least 8 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    const users = readUsers();
    if (users.some(user => user.email === email)) return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    const credentials = hashPassword(password);
    users.push({ id: randomUUID(), name, phone, email, passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt: new Date().toISOString() });
    writeUsers(users);
    return res.status(201).json({ success: true, message: "Account created. Please sign in to continue." });
  } catch (err) { console.error("Signup failed:", err.message); return res.status(500).json({ error: "Could not save your account on this server." }); }
});

app.post("/api/signin", (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const user = readUsers().find(item => item.email === email);
    if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: "Email or password is incorrect." });
    return res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone, email: user.email } });
  } catch (err) { console.error("Signin failed:", err.message); return res.status(500).json({ error: "Could not sign in. Please try again." }); }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    application: "CashFlow Sentinel",
    message: "Local backend is running",
    aws: { region: REGION, bucketConfigured: Boolean(BUCKET), tableConfigured: Boolean(TABLE_NAME), apiGatewayConfigured: Boolean(AWS_API_BASE_URL) }
  });
});

app.post("/api/analyze", async (req, res) => {
  // When configured, send analysis through API Gateway so Lambda runs
  // Bedrock insights, DynamoDB persistence, and SNS critical email alerts.
  if (AWS_API_BASE_URL) {
    try {
      const response = await fetch(`${AWS_API_BASE_URL}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body || {}),
        signal: AbortSignal.timeout(60000)
      });
      const data = await response.json().catch(() => ({}));
      return res.status(response.status).json(data);
    } catch (err) {
      console.error("AWS analysis API failed:", err.message);
      return res.status(502).json({ error: "Could not reach the AWS analysis API. Check your internet connection and AWS_API_BASE_URL.", detail: err.message });
    }
  }
  try {
    const result = analyze(req.body || {});
    let savedToDynamoDB = false;
    try {
      await saveAnalysis(result);
      savedToDynamoDB = true;
    } catch (err) {
      console.error("DynamoDB save failed:", err.name, err.message);
    }
    res.json({ ...result, savedToDynamoDB, storageNote: savedToDynamoDB ? "Analysis saved to DynamoDB." : "Analysis calculated locally, but DynamoDB save failed. Check AWS credentials, region, table key, and IAM permissions." });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Analysis failed." });
  }
});

app.post("/api/analyze-csv", upload.single("file"), async (req, res) => {
  try {
    let csvText;
    let source;
    if (req.file) {
      csvText = req.file.buffer.toString("utf8");
      source = `uploaded file: ${req.file.originalname}`;
    } else {
      const key = String(req.body?.key || DEFAULT_KEY);
      const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      csvText = await streamToString(object.Body);
      source = `s3://${BUCKET}/${key}`;
    }

    const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    if (!records.length) return res.status(400).json({ error: "CSV has a header but no data rows." });
    const keys = Object.keys(records[0]);
    const findColumn = (candidates) => keys.find(k => candidates.includes(k.toLowerCase().replace(/[^a-z0-9]/g, "")));
    const amountKey = findColumn(["amount", "transactionamount", "value", "transactionvalue"]);
    const typeKey = findColumn(["type", "transactiontype", "category", "direction"]);
    const dateKey = findColumn(["date", "transactiondate", "timestamp"]);
    if (!amountKey) {
      return res.status(400).json({
        error: "Could not identify an amount column in the CSV.",
        detectedColumns: keys,
        expectedExample: "date,description,type,amount (type can be income/expense)"
      });
    }

    let income = 0, expenses = 0, validRows = 0;
    const recent = [];
    for (const row of records) {
      const amount = Number(String(row[amountKey]).replace(/[₹,$\s]/g, ""));
      if (!Number.isFinite(amount)) continue;
      const type = String(typeKey ? row[typeKey] : "").toLowerCase();
      const isIncome = /income|credit|deposit|sales|receipt|inflow/.test(type);
      const isExpense = /expense|debit|withdraw|payment|purchase|outflow|cost/.test(type);
      if (isIncome) income += Math.abs(amount);
      else if (isExpense) expenses += Math.abs(amount);
      else if (amount >= 0) income += amount;
      else expenses += Math.abs(amount);
      validRows++;
      if (recent.length < 8) recent.push({ date: dateKey ? row[dateKey] : "", description: row.description || row.Description || row.narration || row.Narration || "Transaction", amount, type: type || "unclassified" });
    }
    res.json({
      source, rowsRead: records.length, validRows, detectedColumns: keys,
      amountColumn: amountKey, typeColumn: typeKey || null,
      totals: { income, expenses, net: income - expenses },
      transactionsPreview: recent,
      note: "CSV classification is heuristic. Confirm whether your file marks income/expenses in a type column before using the totals."
    });
  } catch (err) {
    console.error("CSV analysis failed:", err.name, err.message);
    const status = err.name === "NoSuchKey" || err.name === "NoSuchBucket" ? 502 : 500;
    res.status(status).json({ error: "CSV analysis failed.", detail: err.message, hint: "For S3 mode, verify bucket/key and AWS credentials. You can also upload the CSV directly from the dashboard." });
  }
});

app.get("/api/history", async (req, res) => {
  try {
    const businessId = String(req.query.businessId || "demo-business");
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "businessId = :businessId",
      ExpressionAttributeValues: { ":businessId": businessId },
      Limit: 50
    }));
    const items = (result.Items || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("History read failed:", err.name, err.message);
    res.status(502).json({ error: "Could not load history from DynamoDB. Check IAM Scan permission and table configuration.", detail: err.message });
  }
});

// Payment tracker. Records use CashFlowPayments keys: businessId (PK), paymentId (SK).
// This MVP assumes a trusted local demo. Add authenticated sessions/tenant authorization before production use.
app.get("/api/payments", async (req, res) => {
  try {
    const businessId = String(req.query.businessId || "demo-business");
    const result = await ddb.send(new ScanCommand({
      TableName: PAYMENTS_TABLE,
      FilterExpression: "businessId = :b",
      ExpressionAttributeValues: { ":b": businessId }
    }));
    const items = (result.Items || []).sort((a,b) => String(a.dueDate || "").localeCompare(String(b.dueDate || "")));
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("Payment list failed:", err.name, err.message);
    res.status(502).json({ error: "Could not load payments from CashFlowPayments. Check table keys and IAM Scan permission.", detail: err.message });
  }
});

app.post("/api/payments", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = String(body.businessId || "demo-business").trim();
    const paymentId = String(body.paymentId || `PAY-${randomUUID().slice(0,8).toUpperCase()}`).trim();
    const totalAmount = Number(body.totalAmount);
    const amountPaid = Number(body.amountPaid || 0);
    const dueDate = String(body.dueDate || "");
    const recipientEmail = String(body.recipientEmail || "").trim().toLowerCase();
    if (!businessId || !body.businessName || !body.description || !dueDate || !Number.isFinite(totalAmount) || totalAmount <= 0 || !Number.isFinite(amountPaid) || amountPaid < 0 || amountPaid > totalAmount || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      return res.status(400).json({ error: "Enter business name, description, valid due date, valid recipient email, total amount > 0, and paid amount between 0 and total." });
    }
    const item = { businessId, paymentId, businessName: String(body.businessName).trim(), description: String(body.description).trim(), invoiceId: String(body.invoiceId || `INV-${paymentId}`), dueDate, totalAmount, amountPaid, amountDue: totalAmount - amountPaid, recipientEmail, currency: String(body.currency || "INR"), status: amountPaid === totalAmount ? "PAID" : amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID", reminderStartDays: Number.isInteger(Number(body.reminderStartDays)) ? Math.max(0, Math.min(60, Number(body.reminderStartDays))) : 7, overdueReminder: body.overdueReminder || "weekly", createdAt: new Date().toISOString(), lastUpcomingReminderDate: "" };
    await ddb.send(new PutCommand({ TableName: PAYMENTS_TABLE, Item: item, ConditionExpression: "attribute_not_exists(businessId) AND attribute_not_exists(paymentId)" }));
    res.status(201).json({ success: true, item });
  } catch (err) {
    const conflict = err.name === "ConditionalCheckFailedException";
    console.error("Payment create failed:", err.name, err.message);
    res.status(conflict ? 409 : 502).json({ error: conflict ? "That payment ID already exists for this business." : "Could not save payment. Check CashFlowPayments table and IAM PutItem permission.", detail: err.message });
  }
});

app.post("/api/payments/:paymentId/record-payment", async (req, res) => {
  try {
    const businessId = String(req.body?.businessId || "demo-business");
    const paymentId = String(req.params.paymentId);
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Payment amount must be greater than zero." });
    const current = await ddb.send(new GetCommand({ TableName: PAYMENTS_TABLE, Key: { businessId, paymentId }, ConsistentRead: true }));
    if (!current.Item) return res.status(404).json({ error: "Payment record not found." });
    const item = current.Item;
    if (item.status === "PAID" || amount > Number(item.amountDue)) return res.status(400).json({ error: item.status === "PAID" ? "This invoice is already paid." : "Payment exceeds the outstanding amount." });
    const newPaid = Number(item.amountPaid || 0) + amount;
    const status = newPaid >= Number(item.totalAmount) ? "PAID" : "PARTIALLY_PAID";
    const result = await ddb.send(new UpdateCommand({ TableName: PAYMENTS_TABLE, Key: { businessId, paymentId }, UpdateExpression: "SET amountPaid = :paid, amountDue = :due, #s = :status, lastPaymentDate = :date, paymentHistory = list_append(if_not_exists(paymentHistory, :empty), :entry)", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":paid": newPaid, ":due": Number(item.totalAmount) - newPaid, ":status": status, ":date": new Date().toISOString(), ":empty": [], ":entry": [{ amount, date: new Date().toISOString(), note: String(req.body?.note || "Payment recorded"), receiptKey: null }] }, ReturnValues: "ALL_NEW" }));
    res.json({ success: true, item: result.Attributes });
  } catch (err) {
    console.error("Record payment failed:", err.name, err.message);
    res.status(502).json({ error: "Could not record payment.", detail: err.message });
  }
});

app.post("/api/payments/:paymentId/receipt", upload.single("receipt"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a receipt file first." });
    const businessId = String(req.body?.businessId || "demo-business");
    const paymentId = String(req.params.paymentId);
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: "Receipt must be PDF, JPG, PNG or WEBP." });
    const key = `payment-receipts/${encodeURIComponent(businessId)}/${encodeURIComponent(paymentId)}/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    await s3.send(new PutObjectCommand({ Bucket: RECEIPTS_BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype, ServerSideEncryption: "AES256" }));
    const current = await ddb.send(new GetCommand({ TableName: PAYMENTS_TABLE, Key: { businessId, paymentId }, ConsistentRead: true }));
    if (!current.Item) return res.status(404).json({ error: "Receipt uploaded but payment record was not found; contact the app owner." });
    const result = await ddb.send(new UpdateCommand({ TableName: PAYMENTS_TABLE, Key: { businessId, paymentId }, UpdateExpression: "SET receiptKeys = list_append(if_not_exists(receiptKeys, :empty), :key)", ExpressionAttributeValues: { ":empty": [], ":key": [{ key, uploadedAt: new Date().toISOString(), filename: req.file.originalname, contentType: req.file.mimetype }] }, ReturnValues: "ALL_NEW" }));
    res.json({ success: true, receipt: result.Attributes.receiptKeys.at(-1), message: "Receipt stored privately in S3; the app does not verify the payment itself." });
  } catch (err) {
    console.error("Receipt upload failed:", err.name, err.message);
    res.status(502).json({ error: "Receipt upload failed. Check S3 bucket and IAM PutObject permission.", detail: err.message });
  }
});

app.post("/api/payments/:paymentId/test-reminder", async (req, res) => {
  try {
    const businessId = String(req.body?.businessId || "demo-business");
    const paymentId = String(req.params.paymentId);
    const result = await ddb.send(new GetCommand({ TableName: PAYMENTS_TABLE, Key: { businessId, paymentId }, ConsistentRead: true }));
    const p = result.Item;
    if (!p) return res.status(404).json({ error: "Payment not found." });
    if (p.status === "PAID" || Number(p.amountDue) <= 0) return res.status(400).json({ error: "No reminder sent because this payment is fully paid." });
    if (!SES_FROM_EMAIL) return res.status(503).json({ error: "Set SES_FROM_EMAIL and verify it in Amazon SES before sending a test email." });
    const body = `Payment reminder test\nBusiness: ${p.businessName}\nInvoice: ${p.invoiceId || p.paymentId}\nDetails: ${p.description}\nDue date: ${p.dueDate}\nTotal: ${p.currency || "INR"} ${p.totalAmount}\nPaid: ${p.currency || "INR"} ${p.amountPaid}\nOutstanding: ${p.currency || "INR"} ${p.amountDue}\n\nThis is a test reminder from CashFlow Sentinel.`;
    await ses.send(new SendEmailCommand({
      FromEmailAddress: SES_FROM_EMAIL,
      Destination: { ToAddresses: [p.recipientEmail] },
      Content: { Simple: {
        Subject: { Data: `CashFlow Sentinel payment reminder: ${p.paymentId}`.slice(0, 100) },
        Body: { Text: { Data: body } }
      } }
    }));
    res.json({ success: true, message: `Test reminder submitted to SES for ${p.recipientEmail}. Check SES sending status and recipient inbox.` });
  } catch (err) {
    console.error("Test reminder failed:", err.name, err.message);
    res.status(502).json({ error: "Could not publish reminder. Check SES sender verification and IAM ses:SendEmail permission.", detail: err.message });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({ region: REGION, bucket: BUCKET, table: TABLE_NAME, apiGatewayBaseUrl: AWS_API_BASE_URL || null });
});

app.post("/api/copilot", async (req, res) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) return res.status(400).json({ error: "Enter a question first." });
    if (question.length > 4000) return res.status(413).json({ error: "Question is too long." });
    const context = req.body?.context && typeof req.body.context === "object" ? req.body.context : {};
    const result = await bedrock.send(new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: "You are CashFlow Sentinel, a financial operations copilot for small businesses. Explain assumptions, do not invent financial figures or claim actions such as sending emails or making payments. This is decision support, not professional financial advice. Be concise and practical." }],
      messages: [{ role: "user", content: [{ text: question + (Object.keys(context).length ? "\\n\\nSupplied business context: " + JSON.stringify(context).slice(0, 12000) : "") }] }],
      inferenceConfig: { maxTokens: 700, temperature: 0.2 }
    }));
    const answer = (result.output?.message?.content || []).filter(x => typeof x.text === "string").map(x => x.text).join("\\n").trim();
    if (!answer) return res.status(502).json({ error: "Bedrock returned an empty answer." });
    res.json({ answer, model: BEDROCK_MODEL_ID, region: REGION });
  } catch (error) {
    console.error("Copilot error:", error?.name, error?.message);
    const name = error?.name || "";
    const status = name.includes("Credentials") ? 503 : name === "AccessDeniedException" ? 403 : 502;
    res.status(status).json({ error: status === 403 ? "AWS denied Bedrock access. Check IAM permissions and model access." : status === 503 ? "AWS credentials are missing or invalid on the server." : "Copilot request failed. Check the backend terminal and Bedrock model/region settings." });
  }
});

app.listen(PORT, () => {
  console.log(`CashFlow Sentinel running at http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
