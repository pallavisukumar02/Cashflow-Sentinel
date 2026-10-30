require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const multer = require("multer");
const crypto = require("node:crypto");
const path = require("node:path");
const { parse } = require("csv-parse/sync");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  GetCommand,
  UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const {
  SESv2Client,
  SendEmailCommand
} = require("@aws-sdk/client-sesv2");

const {
  BedrockRuntimeClient,
  ConverseCommand
} = require("@aws-sdk/client-bedrock-runtime");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const REGION = process.env.AWS_REGION || "ap-southeast-2";

const TABLE_NAME = process.env.DDB_TABLE || "CashFlowAnalyses";
const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || "CashFlowPayments";

const BUCKET = process.env.S3_BUCKET || "cashflow-sentinel-pallavi-2026";
const RECEIPTS_BUCKET = process.env.RECEIPTS_BUCKET || BUCKET;
const DEFAULT_KEY = process.env.S3_KEY || "sample-transaction.csv";

const AWS_API_BASE_URL = (process.env.AWS_API_BASE_URL || "").replace(/\/$/, "");

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || "";
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0";

const COGNITO_ISSUER_URL = (process.env.COGNITO_ISSUER_URL || "").replace(/\/$/, "");
const COGNITO_DOMAIN = (process.env.COGNITO_DOMAIN || "").replace(/\/$/, "");
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";
const COGNITO_CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET || "";
const COGNITO_REDIRECT_URI = process.env.COGNITO_REDIRECT_URI || "";
const COGNITO_LOGOUT_URI = process.env.COGNITO_LOGOUT_URI || "https://cashflow-sentinel.onrender.com/";

const SESSION_SECRET = process.env.SESSION_SECRET || "";

const AUTH_CONFIGURED = Boolean(
  COGNITO_ISSUER_URL &&
  COGNITO_DOMAIN &&
  COGNITO_CLIENT_ID &&
  COGNITO_CLIENT_SECRET &&
  COGNITO_REDIRECT_URI &&
  SESSION_SECRET
);

const cognitoJwks = AUTH_CONFIGURED
  ? createRemoteJWKSet(
      new URL(`${COGNITO_ISSUER_URL}/.well-known/jwks.json`)
    )
  : null;

const awsCredentials =
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID.trim(),
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY.trim()
      }
    : undefined;

const awsConfig = {
  region: REGION,
  ...(awsCredentials ? { credentials: awsCredentials } : {})
};

const s3 = new S3Client(awsConfig);

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient(awsConfig)
);

const ses = new SESv2Client({ region: REGION, ...(
  awsCredentials ? { credentials: awsCredentials } : {}
) });

const bedrock = new BedrockRuntimeClient({
  region: REGION,
  ...(awsCredentials ? { credentials: awsCredentials } : {})
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

app.set("trust proxy", 1);

app.use(cors({
  origin: "https://cashflow-sentinel.onrender.com",
  credentials: true
}));

app.use(express.json({ limit: "1mb" }));

app.use(session({
  name: "cashflow.sid",
  secret: SESSION_SECRET || "development-only-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------
// AUTHENTICATION
// ------------------------------------------

function requireAuth(req, res, next) {
  if (!AUTH_CONFIGURED) {
    return res.status(503).json({
      error: "Cognito is not configured."
    });
  }

  const token = req.session?.idToken;

  if (!token) {
    return res.status(401).json({
      error: "Please sign in.",
      loginUrl: "/auth/login"
    });
  }

  jwtVerify(token, cognitoJwks, {
    issuer: COGNITO_ISSUER_URL,
    audience: COGNITO_CLIENT_ID,
    algorithms: ["RS256"]
  })
    .then(({ payload }) => {
      if (payload.token_use !== "id" || !payload.sub) {
        throw new Error("Invalid Cognito identity token.");
      }

      req.auth = {
        sub: String(payload.sub),
        email: String(payload.email || ""),
        name: String(
          payload.name ||
          payload.given_name ||
          payload.email ||
          "User"
        )
      };

      next();
    })
    .catch(error => {
      console.error("Authentication error:", error.message);

      req.session.destroy(() => {});

      res.status(401).json({
        error: "Session expired. Please sign in again.",
        loginUrl: "/auth/login"
      });
    });
}

app.get("/auth/login", (req, res) => {
  if (!AUTH_CONFIGURED) {
    return res.status(503).send("Cognito configuration is incomplete.");
  }

  const state = crypto.randomBytes(32).toString("hex");
  const nonce = crypto.randomBytes(32).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");

  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");

  req.session.oauthState = state;
  req.session.oauthNonce = nonce;
  req.session.codeVerifier = verifier;

  const url = new URL(`${COGNITO_DOMAIN}/oauth2/authorize`);

  url.search = new URLSearchParams({
    client_id: COGNITO_CLIENT_ID,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: COGNITO_REDIRECT_URI,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString();

  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (!AUTH_CONFIGURED) {
      return res.status(503).send("Cognito is not configured.");
    }

    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send("Cognito sign-in failed.");
    }

    if (
      !code ||
      !state ||
      !req.session.oauthState ||
      String(state) !== req.session.oauthState ||
      !req.session.codeVerifier
    ) {
      return res.status(400).send("Invalid sign-in state.");
    }

    const tokenResponse = await fetch(
      `${COGNITO_DOMAIN}/oauth2/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
           body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: COGNITO_CLIENT_ID,
      client_secret: COGNITO_CLIENT_SECRET,
          code: String(code),
          redirect_uri: COGNITO_REDIRECT_URI,
          code_verifier: req.session.codeVerifier
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok || !tokens.id_token) {
      console.error("Cognito token exchange failed:", tokens.error);
      return res.status(401).send("Could not complete sign-in.");
    }

    const { payload } = await jwtVerify(
      tokens.id_token,
      cognitoJwks,
      {
        issuer: COGNITO_ISSUER_URL,
        audience: COGNITO_CLIENT_ID,
        algorithms: ["RS256"]
      }
    );

    if (
      payload.token_use !== "id" ||
      payload.nonce !== req.session.oauthNonce ||
      !payload.sub
    ) {
      return res.status(401).send("Cognito token validation failed.");
    }

    req.session.regenerate(err => {
      if (err) {
        console.error("Session regeneration failed:", err);
        return res.status(500).send("Could not create session.");
      }

      req.session.idToken = tokens.id_token;

      req.session.save(saveError => {
        if (saveError) {
          console.error("Session save failed:", saveError);
          return res.status(500).send("Could not save session.");
        }

        res.redirect("/");
      });
    });

  } catch (error) {
    console.error("Cognito callback error:", error.message);
    res.status(500).send("Sign-in could not be completed.");
  }
});

app.get("/auth/me", requireAuth, (req, res) => {
  res.json({
    authenticated: true,
    user: {
      id: req.auth.sub,
      email: req.auth.email,
      name: req.auth.name
    }
  });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("cashflow.sid");

    const url = new URL(`${COGNITO_DOMAIN}/logout`);

    url.search = new URLSearchParams({
      client_id: COGNITO_CLIENT_ID,
      logout_uri: COGNITO_LOGOUT_URI
    }).toString();

    res.json({
      success: true,
      logoutUrl: url.toString()
    });
  });
});

// All API routes require a valid Cognito session.
app.use("/api", requireAuth);

// ------------------------------------------
// CASH FLOW ANALYSIS
// ------------------------------------------

function analyze(input) {
  const required = [
    "currentCash",
    "expectedIncome",
    "expectedExpenses"
  ];

  for (const key of required) {
    if (
      input[key] === undefined ||
      input[key] === null ||
      input[key] === ""
    ) {
      const error = new Error(`Missing required field: ${key}`);
      error.status = 400;
      throw error;
    }
  }

  const cash = Number(input.currentCash);
  const income = Number(input.expectedIncome);
  const expenses = Number(input.expectedExpenses);
  const receivables = Number(input.receivables ?? 0);
  const obligations = Number(input.upcomingObligations ?? 0);

  if (
    [cash, income, expenses, receivables, obligations]
      .some(value => !Number.isFinite(value) || value < 0)
  ) {
    const error = new Error("Enter valid financial amounts.");
    error.status = 400;
    throw error;
  }

  const projectedCash =
    cash + income + receivables - expenses - obligations;

  const warnings = [];

  if (projectedCash < 0) {
    warnings.push(
      "Projected cash deficit: expected outflows exceed available funds."
    );
  } else if (projectedCash < expenses * 0.25) {
    warnings.push(
      "Low cash buffer: funds may be insufficient for unexpected costs."
    );
  }

  if (receivables > 0) {
    warnings.push(
      "Confirm expected customer payment dates before relying on receivables."
    );
  }

  const financialStatus =
    projectedCash < 0
      ? "CRITICAL"
      : projectedCash < expenses * 0.25
        ? "WARNING"
        : "HEALTHY";

  const recommendation =
    financialStatus === "CRITICAL"
      ? "Review discretionary spending, follow up on overdue invoices, and discuss payment extensions with creditors."
      : financialStatus === "WARNING"
        ? "Build a cash buffer and confirm incoming payments before committing to additional expenses."
        : "Continue monitoring payment timing and upcoming obligations.";

  return {
    application: "CashFlow Sentinel",
    businessId: input.businessId,
    analysisId: crypto.randomUUID(),
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
    Item: result
  }));
}

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

app.post("/api/analyze", async (req, res) => {
  try {
    const body = {
      ...(req.body || {}),
      businessId: req.auth.sub
    };

    if (AWS_API_BASE_URL) {
      const response = await fetch(
        `${AWS_API_BASE_URL}/analyze`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000)
        }
      );

      const data = await response.json().catch(() => ({}));
      return res.status(response.status).json(data);
    }

    const result = analyze(body);

    let savedToDynamoDB = false;

    try {
      await saveAnalysis(result);
      savedToDynamoDB = true;
    } catch (error) {
      console.error("DynamoDB save failed:", error.message);
    }

    res.json({
      ...result,
      savedToDynamoDB,
      storageNote: savedToDynamoDB
        ? "Analysis saved to DynamoDB."
        : "Analysis calculated locally, but DynamoDB save failed."
    });

  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Analysis failed."
    });
  }
});

// ------------------------------------------
// CSV ANALYSIS
// ------------------------------------------

app.post("/api/analyze-csv", upload.single("file"), async (req, res) => {
  try {
    let csvText;
    let source;

    if (req.file) {
      csvText = req.file.buffer.toString("utf8");
      source = `uploaded file: ${req.file.originalname}`;
    } else {
      const key = DEFAULT_KEY;
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET,
          Key: key
        })
      );

      csvText = await streamToString(object.Body);
      source = `s3://${BUCKET}/${key}`;
    }

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });

    if (!records.length) {
      return res.status(400).json({
        error: "CSV has a header but no data rows."
      });
    }

    const keys = Object.keys(records[0]);

    const findColumn = candidates =>
      keys.find(key =>
        candidates.includes(
          key.toLowerCase().replace(/[^a-z0-9]/g, "")
        )
      );

    const amountKey = findColumn([
      "amount",
      "transactionamount",
      "value",
      "transactionvalue"
    ]);

    const typeKey = findColumn([
      "type",
      "transactiontype",
      "category",
      "direction"
    ]);

    const dateKey = findColumn([
      "date",
      "transactiondate",
      "timestamp"
    ]);

    if (!amountKey) {
      return res.status(400).json({
        error: "Could not identify an amount column.",
        detectedColumns: keys
      });
    }

    let income = 0;
    let expenses = 0;
    let validRows = 0;

    const recent = [];

    for (const row of records) {
      const amount = Number(
        String(row[amountKey]).replace(/[₹,$\s]/g, "")
      );

      if (!Number.isFinite(amount)) continue;

      const type = String(typeKey ? row[typeKey] : "").toLowerCase();

      if (/income|credit|deposit|sales|receipt|inflow/.test(type)) {
        income += Math.abs(amount);
      } else if (/expense|debit|withdraw|payment|purchase|outflow|cost/.test(type)) {
        expenses += Math.abs(amount);
      } else if (amount >= 0) {
        income += amount;
      } else {
        expenses += Math.abs(amount);
      }

      validRows++;

      if (recent.length < 8) {
        recent.push({
          date: dateKey ? row[dateKey] : "",
          description: row.description || row.Description || "Transaction",
          amount,
          type: type || "unclassified"
        });
      }
    }

    res.json({
      source,
      rowsRead: records.length,
      validRows,
      detectedColumns: keys,
      amountColumn: amountKey,
      typeColumn: typeKey || null,
      totals: {
        income,
        expenses,
        net: income - expenses
      },
      transactionsPreview: recent,
      note: "CSV classification is heuristic. Confirm the transaction type column."
    });

  } catch (error) {
    console.error("CSV analysis failed:", error.message);

    res.status(502).json({
      error: "CSV analysis failed.",
      detail: error.message
    });
  }
});

// ------------------------------------------
// ANALYSIS HISTORY
// ------------------------------------------

app.get("/api/history", async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "businessId = :businessId",
        ExpressionAttributeValues: {
          ":businessId": req.auth.sub
        },
        Limit: 50
      })
    );

    const items = (result.Items || []).sort(
      (a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt))
    );

    res.json({
      items,
      count: items.length
    });

  } catch (error) {
    console.error("History read failed:", error.message);

    res.status(502).json({
      error: "Could not load history.",
      detail: error.message
    });
  }
});

// ------------------------------------------
// PAYMENT TRACKER
// ------------------------------------------

app.get("/api/payments", async (req, res) => {
  try {
    const result = await ddb.send(
      new ScanCommand({
        TableName: PAYMENTS_TABLE,
        FilterExpression: "businessId = :businessId",
        ExpressionAttributeValues: {
          ":businessId": req.auth.sub
        }
      })
    );

    const items = (result.Items || []).sort(
      (a, b) =>
        String(a.dueDate || "").localeCompare(String(b.dueDate || ""))
    );

    res.json({
      items,
      count: items.length
    });

  } catch (error) {
    console.error("Payment list failed:", error.message);

    res.status(502).json({
      error: "Could not load payments.",
      detail: error.message
    });
  }
});

app.post("/api/payments", async (req, res) => {
  try {
    const body = req.body || {};

    const businessId = req.auth.sub;

    const paymentId = String(
      body.paymentId ||
      `PAY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
    ).trim();

    const totalAmount = Number(body.totalAmount);
    const amountPaid = Number(body.amountPaid || 0);
    const dueDate = String(body.dueDate || "");
    const recipientEmail = String(body.recipientEmail || "")
      .trim()
      .toLowerCase();

    if (
      !body.businessName ||
      !body.description ||
      !dueDate ||
      !Number.isFinite(totalAmount) ||
      totalAmount <= 0 ||
      !Number.isFinite(amountPaid) ||
      amountPaid < 0 ||
      amountPaid > totalAmount ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)
    ) {
      return res.status(400).json({
        error: "Enter valid payment details."
      });
    }

    const item = {
      businessId,
      paymentId,
      businessName: String(body.businessName).trim(),
      description: String(body.description).trim(),
      invoiceId: String(body.invoiceId || `INV-${paymentId}`),
      dueDate,
      totalAmount,
      amountPaid,
      amountDue: totalAmount - amountPaid,
      recipientEmail,
      currency: String(body.currency || "INR"),
      status:
        amountPaid === totalAmount
          ? "PAID"
          : amountPaid > 0
            ? "PARTIALLY_PAID"
            : "UNPAID",
      createdAt: new Date().toISOString(),
      lastUpcomingReminderDate: ""
    };

    await ddb.send(
      new PutCommand({
        TableName: PAYMENTS_TABLE,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(businessId) AND attribute_not_exists(paymentId)"
      })
    );

    res.status(201).json({
      success: true,
      item
    });

  } catch (error) {
    console.error("Payment create failed:", error.message);

    res.status(
      error.name === "ConditionalCheckFailedException" ? 409 : 502
    ).json({
      error: "Could not save payment.",
      detail: error.message
    });
  }
});

app.post("/api/payments/:paymentId/record-payment", async (req, res) => {
  try {
    const businessId = req.auth.sub;
    const paymentId = String(req.params.paymentId);
    const amount = Number(req.body?.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Payment amount must be greater than zero."
      });
    }

    const current = await ddb.send(
      new GetCommand({
        TableName: PAYMENTS_TABLE,
        Key: { businessId, paymentId },
        ConsistentRead: true
      })
    );

    if (!current.Item) {
      return res.status(404).json({
        error: "Payment record not found."
      });
    }

    const item = current.Item;

    if (
      item.status === "PAID" ||
      amount > Number(item.amountDue)
    ) {
      return res.status(400).json({
        error: "Payment exceeds outstanding amount or invoice is already paid."
      });
    }

    const newPaid = Number(item.amountPaid || 0) + amount;

    const status =
      newPaid >= Number(item.totalAmount)
        ? "PAID"
        : "PARTIALLY_PAID";

    const result = await ddb.send(
      new UpdateCommand({
        TableName: PAYMENTS_TABLE,
        Key: { businessId, paymentId },
        UpdateExpression:
          "SET amountPaid = :paid, amountDue = :due, #s = :status, lastPaymentDate = :date",
        ExpressionAttributeNames: {
          "#s": "status"
        },
        ExpressionAttributeValues: {
          ":paid": newPaid,
          ":due": Number(item.totalAmount) - newPaid,
          ":status": status,
          ":date": new Date().toISOString()
        },
        ReturnValues: "ALL_NEW"
      })
    );

    res.json({
      success: true,
      item: result.Attributes
    });

  } catch (error) {
    console.error("Record payment failed:", error.message);

    res.status(502).json({
      error: "Could not record payment.",
      detail: error.message
    });
  }
});

// ------------------------------------------
// RECEIPT UPLOAD
// ------------------------------------------

app.post(
  "/api/payments/:paymentId/receipt",
  upload.single("receipt"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Choose a receipt file first."
        });
      }

      const businessId = req.auth.sub;
      const paymentId = String(req.params.paymentId);

      const allowed = [
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp"
      ];

      if (!allowed.includes(req.file.mimetype)) {
        return res.status(400).json({
          error: "Receipt must be PDF, JPG, PNG or WEBP."
        });
      }

      const current = await ddb.send(
        new GetCommand({
          TableName: PAYMENTS_TABLE,
          Key: { businessId, paymentId },
          ConsistentRead: true
        })
      );

      if (!current.Item) {
        return res.status(404).json({
          error: "Payment record not found."
        });
      }

      const key =
        `payment-receipts/${encodeURIComponent(businessId)}/` +
        `${encodeURIComponent(paymentId)}/` +
        `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: RECEIPTS_BUCKET,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
          ServerSideEncryption: "AES256"
        })
      );

      const result = await ddb.send(
        new UpdateCommand({
          TableName: PAYMENTS_TABLE,
          Key: { businessId, paymentId },
          UpdateExpression:
            "SET receiptKeys = list_append(if_not_exists(receiptKeys, :empty), :key)",
          ExpressionAttributeValues: {
            ":empty": [],
            ":key": [{
              key,
              uploadedAt: new Date().toISOString(),
              filename: req.file.originalname,
              contentType: req.file.mimetype
            }]
          },
          ReturnValues: "ALL_NEW"
        })
      );

      res.json({
        success: true,
        receipt: result.Attributes.receiptKeys.at(-1)
      });

    } catch (error) {
      console.error("Receipt upload failed:", error.message);

      res.status(502).json({
        error: "Receipt upload failed.",
        detail: error.message
      });
    }
  }
);

// ------------------------------------------
// TEST PAYMENT REMINDER
// ------------------------------------------

app.post("/api/payments/:paymentId/test-reminder", async (req, res) => {
  try {
    const businessId = req.auth.sub;
    const paymentId = String(req.params.paymentId);

    const result = await ddb.send(
      new GetCommand({
        TableName: PAYMENTS_TABLE,
        Key: { businessId, paymentId },
        ConsistentRead: true
      })
    );

    const payment = result.Item;

    if (!payment) {
      return res.status(404).json({
        error: "Payment not found."
      });
    }

    if (payment.status === "PAID" || Number(payment.amountDue) <= 0) {
      return res.status(400).json({
        error: "This payment is already paid."
      });
    }

    if (!SES_FROM_EMAIL) {
      return res.status(503).json({
        error: "Configure SES_FROM_EMAIL first."
      });
    }

    const body =
      `Payment reminder test\n` +
      `Business: ${payment.businessName}\n` +
      `Invoice: ${payment.invoiceId || payment.paymentId}\n` +
      `Details: ${payment.description}\n` +
      `Due date: ${payment.dueDate}\n` +
      `Outstanding: ${payment.currency || "INR"} ${payment.amountDue}\n`;

    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: SES_FROM_EMAIL,
        Destination: {
          ToAddresses: [payment.recipientEmail]
        },
        Content: {
          Simple: {
            Subject: {
              Data: `CashFlow Sentinel payment reminder: ${payment.paymentId}`
            },
            Body: {
              Text: { Data: body }
            }
          }
        }
      })
    );

    res.json({
      success: true,
      message: "Reminder submitted to Amazon SES."
    });

  } catch (error) {
    console.error("Reminder failed:", error.message);

    res.status(502).json({
      error: "Could not send reminder.",
      detail: error.message
    });
  }
});

// ------------------------------------------
// CONFIGURATION
// ------------------------------------------

app.get("/api/config", (_req, res) => {
  res.json({
    region: REGION,
    bucket: BUCKET,
    table: TABLE_NAME,
    apiGatewayBaseUrl: AWS_API_BASE_URL || null
  });
});

// ------------------------------------------
// AI COPILOT
// ------------------------------------------

app.post("/api/copilot", async (req, res) => {
  try {
    const question =
      typeof req.body?.question === "string"
        ? req.body.question.trim()
        : "";

    if (!question) {
      return res.status(400).json({
        error: "Enter a question first."
      });
    }

    if (question.length > 4000) {
      return res.status(413).json({
        error: "Question is too long."
      });
    }

    const context =
      req.body?.context &&
      typeof req.body.context === "object"
        ? req.body.context
        : {};

    const result = await bedrock.send(
      new ConverseCommand({
        modelId: BEDROCK_MODEL_ID,
        system: [{
          text:
            "You are CashFlow Sentinel, a financial operations copilot for small businesses. Explain assumptions, do not invent financial figures or claim actions such as sending emails or making payments. This is decision support, not professional financial advice. Be concise and practical."
        }],
        messages: [{
          role: "user",
          content: [{
            text:
              question +
              (Object.keys(context).length
                ? "\n\nSupplied business context: " +
                  JSON.stringify(context).slice(0, 12000)
                : "")
          }]
        }],
        inferenceConfig: {
          maxTokens: 700,
          temperature: 0.2
        }
      })
    );

    const answer = (result.output?.message?.content || [])
      .filter(item => typeof item.text === "string")
      .map(item => item.text)
      .join("\n")
      .trim();

    if (!answer) {
      return res.status(502).json({
        error: "Bedrock returned an empty answer."
      });
    }

    res.json({
      answer,
      model: BEDROCK_MODEL_ID,
      region: REGION
    });

  } catch (error) {
    console.error("Copilot error:", error.message);

    res.status(502).json({
      error: "Copilot request failed."
    });
  }
});

// ------------------------------------------
// HEALTH CHECK
// ------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    application: "CashFlow Sentinel",
    aws: {
      region: REGION,
      bucketConfigured: Boolean(BUCKET),
      tableConfigured: Boolean(TABLE_NAME),
      apiGatewayConfigured: Boolean(AWS_API_BASE_URL)
    },
    authentication: {
      provider: "Amazon Cognito",
      configured: AUTH_CONFIGURED
    }
  });
});

// ------------------------------------------
// START SERVER
// ------------------------------------------

app.listen(PORT, () => {
  console.log(`CashFlow Sentinel running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
