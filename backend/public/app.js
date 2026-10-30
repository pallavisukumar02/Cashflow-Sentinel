const $ = (id) => document.getElementById(id);

const gateScreens = ["welcomeScreen", "signupScreen", "signinScreen", "featureScreen"];

function showScreen(id) {
  gateScreens.forEach(screenId => $(screenId).classList.toggle("hidden", screenId !== id));
  $("dashboardShell").classList.toggle("hidden", id !== "dashboard");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function authMessage(id, text, kind = "") {
  const el = $(id);
  el.hidden = false;
  el.className = `message ${kind}`.trim();
  el.textContent = text;
}

$("getStartedBtn").addEventListener("click", () => showScreen("signupScreen"));
document.querySelectorAll("[data-back]").forEach(button =>
  button.addEventListener("click", () => showScreen(button.dataset.back))
);
$("toSigninBtn").addEventListener("click", () => showScreen("signinScreen"));
$("toSignupBtn").addEventListener("click", () => showScreen("signupScreen"));

// ==========================================
// AMAZON COGNITO AUTHENTICATION
// ==========================================

function startCognitoLogin(event) {
  event.preventDefault();
  window.location.assign("/auth/login");
}

$("signupForm").addEventListener("submit", startCognitoLogin);
$("signinForm").addEventListener("submit", startCognitoLogin);

async function signOutCognito() {
  try {
    const result = await request("/auth/logout", { method: "POST" });
    window.location.assign(result.logoutUrl || "/");
  } catch (error) {
    authMessage("signinMessage", error.message, "error");
  }
}

$("signoutBtn").addEventListener("click", signOutCognito);

document.querySelectorAll("[data-feature]").forEach(button =>
  button.addEventListener("click", () => {
    showScreen("dashboard");
    const feature = button.dataset.feature;
    const target =
      feature === "transactions" ? $("transactionsPanel") :
      feature === "history" ? document.querySelector(".history-panel") :
      feature === "analysis" ? $("analysisPanel") :
      feature === "copilot" ? $("copilotPanel") :
      document.querySelector(".topbar");

    document.querySelectorAll(".nav-item").forEach(nav =>
      nav.classList.toggle(
        "active",
        nav.dataset.tab === (
          feature === "transactions" ? "transactions" :
          feature === "history" ? "history" : feature
        )
      )
    );

    setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  })
);

let latestAnalysis = null;
const currencySymbols = { INR: "₹", USD: "$" };

function money(value, currency = "INR") {
  const symbol = currencySymbols[currency] || `${currency} `;
  return symbol + Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  });
}

function showMessage(id, message, kind = "") {
  const el = $(id);
  el.hidden = false;
  el.className = `message ${kind}`.trim();
  el.textContent = message;
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 401 && url !== "/auth/me") {
    window.location.assign("/auth/login");
    throw new Error("Please sign in again.");
  }

  if (!response.ok) {
    throw new Error(
      data.error || data.message ||
      `Request failed (${response.status})${data.detail ? ": " + data.detail : ""}`
    );
  }

  return data;
}

async function checkHealth() {
  try {
    const data = await request("/health");
    $("apiStatus").textContent =
      data.status === "ok" ? "Connected · CashFlow Sentinel" : "API response received";
    $("apiStatus").style.color = "#80f4cf";
  } catch {
    $("apiStatus").textContent = "API unavailable · start server";
    $("apiStatus").style.color = "#ff9da7";
  }
}

function renderRiskChart(data) {
  const available = Math.max(
    0,
    Number(data.currentCash || 0) +
    Number(data.expectedIncome || 0) +
    Number(data.receivables || 0)
  );

  const due = Math.max(
    0,
    Number(data.expectedExpenses || 0) +
    Number(data.upcomingObligations || 0)
  );

  const scale = Math.max(available, due, 1);
  const shortfall = Math.max(0, due - available);
  const risk = due === 0 ? 0 : Math.min(100, Math.round(shortfall / due * 100));

  $("riskPercent").textContent = `${risk}% risk`;
  $("riskPercent").style.color =
    risk >= 50 ? "#d84e5d" : risk > 0 ? "#bd8426" : "#168e68";

  const bar = (label, amount, cls) =>
    `<div class="chart-row"><span>${label}</span><div class="chart-track"><div class="chart-bar ${cls}" style="width:${Math.max(amount > 0 ? 2 : 0, amount / scale * 100)}%"></div></div><b class="chart-value">${escapeHtml(money(amount, data.currency || "INR"))}</b></div>`;

  $("riskChart").innerHTML =
    bar("Funds available", available, "available") +
    bar("Payments due", due, "due");

  $("riskChartSummary").textContent = shortfall > 0
    ? `Potential shortfall of ${money(shortfall, data.currency || "INR")}. Due payments exceed projected available funds. This is a planning signal, not a prediction of actual default.`
    : `Projected available funds cover the listed payments by ${money(available - due, data.currency || "INR")}. Keep checking payment dates and receivables.`;
}

function renderAnalysis(data) {
  latestAnalysis = data;
  renderRiskChart(data);

  const sym = data.currency || "INR";
  const status = data.financialStatus || "UNKNOWN";

  if (status === "CRITICAL" && soundEnabled) playAlertSound();

  $("metricProjected").textContent = money(data.projectedCash, sym);
  $("metricProjectedNote").textContent =
    data.projectedCash < 0 ? "Projected shortfall" : "Projected end-of-period balance";
  $("heroProjected").textContent = money(data.projectedCash, sym);
  $("heroRisk").textContent = status;
  $("metricStatus").textContent = status;
  $("metricStatus").style.color =
    status === "CRITICAL" ? "#d84e5d" :
    status === "WARNING" ? "#bd8426" : "#168e68";

  $("metricStatusNote").textContent =
    status === "CRITICAL" ? "Immediate cash pressure" :
    status === "WARNING" ? "Cash buffer is low" :
    "Projected cash buffer looks healthy";

  $("metricTime").textContent = formatDate(data.createdAt);
  $("metricId").textContent = `ID: ${(data.analysisId || "—").slice(0, 12)}`;
  $("resultProjected").textContent = money(data.projectedCash, sym);

  $("resultFormula").textContent =
    `${money(data.currentCash, sym)} + ${money(data.expectedIncome, sym)} + ${money(data.receivables, sym)} − ${money(data.expectedExpenses, sym)} − ${money(data.upcomingObligations, sym)}`;

  const statusEl = $("resultStatus");
  statusEl.className = `result-status ${status.toLowerCase()}`;

  statusEl.querySelector("b").textContent =
    status === "HEALTHY" ? "Healthy cash position" :
    status === "WARNING" ? "Cash buffer needs attention" :
    status === "CRITICAL" ? "Potential cash deficit" : status;

  const warnings = Array.isArray(data.warnings) ? data.warnings : [];

  $("warningsList").innerHTML = warnings.length
    ? warnings.map(w => `<li>${escapeHtml(w)}</li>`).join("")
    : "<li>No risk signals detected by this basic rule-based check.</li>";

  $("recommendationText").textContent =
    data.recommendation || "Review your projected cash position.";

  $("aiInsightText").textContent =
    data.aiInsight || data.aiNote || "AI insights were not returned by the API.";

  $("aiProvider").textContent =
    data.aiStatus === "success"
      ? `Powered by ${data.aiProvider || "Amazon Bedrock"} · ${data.aiModel || "Nova Lite"}`
      : (data.aiStatus ? `AI status: ${data.aiStatus}` : "");

  const alert = $("alertStatus");

  if (data.alert) {
    alert.hidden = false;
    alert.className = `message ${data.alert.sent ? "success" : "error"}`;
    alert.textContent = data.alert.sent
      ? `SNS critical alert submitted successfully. Message ID: ${data.alert.messageId || "accepted"}`
      : `SNS alert not sent: ${data.alert.reason || "check Lambda logs and SNS_TOPIC_ARN"}`;
  } else {
    alert.hidden = true;
  }

  $("resultAnalysisId").textContent = data.analysisId || "Not generated";
  $("storageNote").textContent =
    data.storageNote || (data.savedToDynamoDB ? "Saved to DynamoDB." : "Calculated by backend.");
  $("storageNote").style.color = data.savedToDynamoDB ? "#168e68" : "#8995a7";

  showMessage(
    "formMessage",
    data.savedToDynamoDB
      ? "Analysis complete and saved to DynamoDB."
      : "Analysis complete. DynamoDB save was not confirmed; check AWS credentials and IAM permissions.",
    data.savedToDynamoDB ? "success" : ""
  );
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

$("analysisForm").addEventListener("submit", async event => {
  event.preventDefault();

  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());

  for (const key of [
    "currentCash",
    "expectedIncome",
    "receivables",
    "expectedExpenses",
    "upcomingObligations"
  ]) {
    if (payload[key] === "") payload[key] = "0";
    payload[key] = Number(payload[key]);
  }

  const btn = $("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Calculating…";

  try {
    const data = await request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    renderAnalysis(data);
    await loadHistory();
  } catch (err) {
    showMessage("formMessage", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Calculate health <span>↗</span>';
  }
});

$("heroAnalyze").addEventListener("click", () => {
  $("analysisPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  $("analysisForm").querySelector('input[name="currentCash"]').focus({ preventScroll: true });
});

$("copyId").addEventListener("click", async () => {
  if (!latestAnalysis?.analysisId) return;

  try {
    await navigator.clipboard.writeText(latestAnalysis.analysisId);
    $("copyId").textContent = "Copied";
    setTimeout(() => $("copyId").textContent = "Copy", 1200);
  } catch {
    showMessage("formMessage", `Analysis ID: ${latestAnalysis.analysisId}`);
  }
});

$("csvFile").addEventListener("change", event => {
  $("fileName").textContent = event.target.files[0]?.name || "No file selected";
});

$("csvForm").addEventListener("submit", async event => {
  event.preventDefault();

  const file = $("csvFile").files[0];

  if (!file) {
    return showMessage("csvMessage", "Choose a CSV file first, or use “Analyse sample from S3”.", "error");
  }

  await runCsv(new FormData(event.currentTarget));
});

$("s3SampleBtn").addEventListener("click", async () => {
  const form = new FormData();
  form.append("key", "sample-transaction.csv");
  await runCsv(form);
});

async function runCsv(formData) {
  const file = formData.get("file");
  const hasFile = file && typeof file === "object" && file.size > 0;

  if (!hasFile && !formData.get("key")) {
    formData.append("key", "sample-transaction.csv");
  }

  try {
    showMessage("csvMessage", hasFile ? "Uploading and analysing CSV…" : "Reading sample CSV from S3…");

    const data = await request("/api/analyze-csv", {
      method: "POST",
      body: formData
    });

    showMessage(
      "csvMessage",
      `Read ${data.validRows} valid transaction rows from ${data.source}.`,
      "success"
    );

    $("csvResult").hidden = false;
    $("csvResult").innerHTML =
      `<div class="csv-stats"><div><small>ROWS READ</small><b>${data.rowsRead}</b></div><div><small>TOTAL INCOME</small><b>${money(data.totals.income)}</b></div><div><small>TOTAL EXPENSES</small><b>${money(data.totals.expenses)}</b></div></div><p><b>Net movement:</b> ${money(data.totals.net)}. ${escapeHtml(data.note || "")}</p><p><b>Detected columns:</b> ${escapeHtml((data.detectedColumns || []).join(", "))}</p>`;
  } catch (err) {
    showMessage("csvMessage", err.message, "error");
  }
}

async function loadHistory() {
  try {
    const data = await request("/api/history");

    if (!data.items?.length) {
      $("historyList").innerHTML =
        '<div class="empty-state">No saved analyses found for this business yet. Run an analysis and check the DynamoDB save status.</div>';
      return;
    }

    $("historyList").innerHTML = data.items.slice(0, 5).map(item =>
      `<div class="history-item"><div><b>${escapeHtml(item.financialStatus || "Analysis")}</b><small>${escapeHtml(formatDate(item.createdAt))} · ${escapeHtml(String(item.analysisId || "").slice(0, 10))}</small></div><strong>${escapeHtml(money(item.projectedCash, item.currency))}</strong></div>`
    ).join("");
  } catch (err) {
    $("historyList").innerHTML =
      `<div class="empty-state">${escapeHtml(err.message)}<br/>This section needs DynamoDB read permission (Scan).</div>`;
  }
}

async function loadConfig() {
  try {
    const c = await request("/api/config");
    $("awsConfig").textContent = `${c.region} · S3: ${c.bucket} · DynamoDB: ${c.table}`;
  } catch {
    $("awsConfig").textContent = "Could not load AWS configuration";
  }
}

document.querySelectorAll(".nav-item").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    button.classList.add("active");

    const isCopilot = button.dataset.tab === "copilot";
    $("copilotPanel").classList.toggle("hidden", !isCopilot);

    const target = isCopilot
      ? $("copilotPanel")
      : ({
          transactions: $("transactionsPanel"),
          analysis: $("analysisPanel"),
          payments: $("paymentsPanel"),
          history: document.querySelector(".history-panel"),
          overview: document.querySelector(".topbar")
        })[button.dataset.tab] || document.querySelector(".topbar");

    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

$("refreshHistory").addEventListener("click", loadHistory);

// ==========================================
// PAYMENT TRACKER
// ==========================================

let paymentItems = [];
let soundEnabled = true;

const paymentMoney = (value, currency = "INR") => money(value, currency);

function paymentBusinessId() {
  return $("analysisForm").elements.businessId.value;
}

function paymentMessage(message, kind = "") {
  showMessage("paymentMessage", message, kind);
}

function renderPaymentChart(items) {
  const chart = $("paymentChart");

  if (!items.length) {
    chart.innerHTML =
      '<div class="chart-empty">No payment records loaded yet. Add an invoice or import the reminder CSV.</div>';
    return;
  }

  const max = Math.max(1, ...items.map(p => Number(p.totalAmount || 0)));

  chart.innerHTML = items.slice(0, 12).map(p => {
    const total = Number(p.totalAmount || 0);
    const paid = Number(p.amountPaid || 0);
    const due = Number(p.amountDue ?? (total - paid));
    const id = escapeHtml(p.invoiceId || p.paymentId || "Invoice");

    return `<div class="payment-chart-row"><div class="payment-chart-label"><b>${id}</b><small>${escapeHtml(p.status || "UNPAID")}</small></div><div class="stacked-track"><i class="paid-segment" style="width:${Math.min(100, paid / max * 100)}%"></i><i class="due-segment" style="width:${Math.min(100, due / max * 100)}%"></i></div><strong>${escapeHtml(paymentMoney(total, p.currency))}</strong></div>`;
  }).join("");
}

function renderPayments(items) {
  paymentItems = items || [];

  const total = paymentItems.reduce((n, p) => n + Number(p.totalAmount || 0), 0);
  const paid = paymentItems.reduce((n, p) => n + Number(p.amountPaid || 0), 0);
  const due = paymentItems.reduce(
    (n, p) => n + Number(p.amountDue ?? (Number(p.totalAmount || 0) - Number(p.amountPaid || 0))),
    0
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const overdue = paymentItems.filter(p =>
    Number(p.amountDue ?? (Number(p.totalAmount || 0) - Number(p.amountPaid || 0))) > 0 &&
    p.dueDate &&
    new Date(`${p.dueDate}T00:00:00`) < today
  ).length;

  $("payTotal").textContent = paymentItems.length;
  $("payPaid").textContent = paymentMoney(paid, paymentItems[0]?.currency || "INR");
  $("payDue").textContent = paymentMoney(due, paymentItems[0]?.currency || "INR");
  $("payOverdue").textContent = overdue;
  $("paymentCountLabel").textContent = `${paymentItems.length} RECORDS`;

  $("paymentRows").innerHTML = paymentItems.length
    ? paymentItems.map(p => {
        const pid = String(p.paymentId || "");
        const dueAmt = Number(p.amountDue ?? (Number(p.totalAmount || 0) - Number(p.amountPaid || 0)));

        return `<tr><td><b>${escapeHtml(p.invoiceId || pid)}</b><br>${escapeHtml(p.description || "")}<br><span class="muted">${escapeHtml(p.businessName || "")} · ${escapeHtml(p.recipientEmail || "")}</span></td><td>${escapeHtml(p.dueDate || "—")}</td><td>${escapeHtml(paymentMoney(p.totalAmount, p.currency))}</td><td>${escapeHtml(paymentMoney(p.amountPaid, p.currency))}</td><td class="money">${escapeHtml(paymentMoney(dueAmt, p.currency))}</td><td><span class="pill ${String(p.status).toLowerCase()}">${escapeHtml(p.status || "UNPAID")}</span></td><td><button type="button" class="small secondary select-payment" data-payment-id="${escapeHtml(pid)}">Select</button></td></tr>`;
      }).join("")
    : '<tr><td colspan="7">No invoices found for this account. Add an invoice above or import the combined CSV.</td></tr>';

  document.querySelectorAll(".select-payment").forEach(button =>
    button.addEventListener("click", () => {
      $("selectedPaymentId").value = button.dataset.paymentId;

      const item = paymentItems.find(
        p => String(p.paymentId) === button.dataset.paymentId
      );

      if (item) {
        $("recordPaymentAmount").max = Number(item.amountDue || 0);
      }
    })
  );

  renderPaymentChart(paymentItems);
}

async function loadPayments() {
  try {
    const data = await request("/api/payments");
    renderPayments(data.items || []);

    showMessage(
      "paymentMessage",
      `Loaded ${data.count || 0} payment record(s) from CashFlowPayments.`,
      "success"
    );
  } catch (error) {
    renderPayments([]);
    paymentMessage(error.message);
  }
}

$("paymentForm").addEventListener("submit", async event => {
  event.preventDefault();

  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());

  delete payload.businessId;

  payload.totalAmount = Number(payload.totalAmount);
  payload.amountPaid = Number(payload.amountPaid);

  if (!payload.paymentId) {
    payload.paymentId = `PAY-${Date.now().toString().slice(-8)}`;
  }

  try {
    const data = await request("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    $("selectedPaymentId").value = data.item.paymentId;

    paymentMessage(
      `Saved ${data.item.invoiceId} to CashFlowPayments. Status: ${data.item.status}.`,
      "success"
    );

    await loadPayments();
  } catch (error) {
    paymentMessage(error.message);
  }
});

$("refreshPayments").addEventListener("click", loadPayments);

$("recordPaymentBtn").addEventListener("click", async () => {
  const id = $("selectedPaymentId").value.trim();
  const amount = Number($("recordPaymentAmount").value);

  if (!id || !(amount > 0)) {
    return showMessage(
      "paymentMessage",
      "Select an invoice and enter a payment amount greater than zero.",
      "error"
    );
  }

  try {
    const data = await request(
      `/api/payments/${encodeURIComponent(id)}/record-payment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          note: $("recordPaymentNote").value || "Payment recorded in dashboard"
        })
      }
    );

    paymentMessage(
      `Payment recorded. Paid ${paymentMoney(data.item.amountPaid, data.item.currency)}; outstanding ${paymentMoney(data.item.amountDue, data.item.currency)}.`,
      "success"
    );

    await loadPayments();
  } catch (error) {
    paymentMessage(error.message);
  }
});

$("testReminderBtn").addEventListener("click", async () => {
  const id = $("selectedPaymentId").value.trim();

  if (!id) return paymentMessage("Select an invoice first.");

  try {
    const data = await request(
      `/api/payments/${encodeURIComponent(id)}/test-reminder`,
      { method: "POST" }
    );

    paymentMessage(data.message, "success");
  } catch (error) {
    paymentMessage(error.message);
  }
});

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"' && quoted && text[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some(v => v !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }

  row.push(field);
  if (row.some(v => v !== "")) rows.push(row);

  if (!rows.length) return [];

  const headers = rows.shift().map(h => h.trim());

  return rows.map(r =>
    Object.fromEntries(headers.map((h, i) => [h, (r[i] || "").trim()]))
  );
}

$("importPaymentsBtn").addEventListener("click", async () => {
  const file = $("paymentCsvFile").files[0];

  if (!file) {
    return showMessage("paymentImportMessage", "Choose your financial CSV first.", "error");
  }

  try {
    const all = parseCsvText(await file.text());

    const reminderRows = all.filter(
      r => String(r.recordType || "").toLowerCase() === "payment_reminder"
    );

    const financialRows = all.filter(r => r.payment_id || r.paymentId);
    const records = reminderRows.length ? reminderRows : financialRows;

    if (!records.length) {
      throw Error("No invoice rows found. Expected payment_id or paymentId column.");
    }

    let ok = 0;
    const failed = [];

    for (const r of records) {
      const total = Number(r.totalAmount ?? r.total_amount_inr);
      const paid = Number(r.amountPaid ?? r.amount_paid_inr ?? 0);
      const dueDate = r.dueDate || r.due_date;
      const id = r.paymentId || r.payment_id;
      const email = String(r.recipientEmail || r.recipient_email || "").trim();

      const payload = {
        paymentId: id,
        businessName: r.businessName || r.business_name || "Business",
        description: r.description || r.invoiceId || r.invoice_id || id || "Invoice",
        invoiceId: r.invoiceId || r.invoice_id || id,
        dueDate,
        totalAmount: total,
        amountPaid: paid,
        recipientEmail: email,
        currency: r.currency || "INR"
      };

      if (
        !payload.paymentId ||
        !payload.dueDate ||
        !Number.isFinite(total) ||
        total <= 0 ||
        !Number.isFinite(paid) ||
        paid < 0 ||
        paid > total
      ) {
        failed.push(`${id || "row"}: missing ID/date or invalid amounts`);
        continue;
      }

      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        failed.push(`${id}: add a valid recipient_email before importing for email reminders`);
        continue;
      }

      try {
        await request("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        ok++;
      } catch (error) {
        failed.push(`${id}: ${error.message}`);
      }
    }

    showMessage(
      "paymentImportMessage",
      `Imported ${ok} invoice(s).${failed.length ? " Not imported: " + failed.slice(0, 5).join("; ") : ""}`,
      failed.length ? "error" : "success"
    );

    await loadPayments();
  } catch (error) {
    showMessage("paymentImportMessage", error.message, "error");
  }
});

// ==========================================
// LANGUAGE SUPPORT
// ==========================================

const translations = {
  en: {
    overview: "Overview",
    analysis: "Cash-flow analysis",
    transactions: "Transactions CSV",
    payments: "Payments & reminders",
    history: "Analysis history",
    language: "Language / ಭಾಷೆ",
    greeting: "Good business starts with",
    run: "Run an analysis"
  },
  hi: {
    overview: "अवलोकन",
    analysis: "नकदी प्रवाह विश्लेषण",
    transactions: "लेन-देन CSV",
    payments: "भुगतान और रिमाइंडर",
    history: "विश्लेषण इतिहास",
    language: "भाषा",
    greeting: "अच्छा व्यवसाय शुरू होता है",
    run: "विश्लेषण चलाएँ"
  },
  kn: {
    overview: "ಅವಲೋಕನ",
    analysis: "ನಗದು ಹರಿವು ವಿಶ್ಲೇಷಣೆ",
    transactions: "ವಹಿವಾಟು CSV",
    payments: "ಪಾವತಿಗಳು ಮತ್ತು ಜ್ಞಾಪನೆಗಳು",
    history: "ವಿಶ್ಲೇಷಣೆ ಇತಿಹಾಸ",
    language: "ಭಾಷೆ",
    greeting: "ಉತ್ತಮ ವ್ಯವಹಾರ ಆರಂಭವಾಗುವುದು",
    run: "ವಿಶ್ಲೇಷಣೆ ನಡೆಸಿ"
  },
  ta: {
    overview: "கண்ணோட்டம்",
    analysis: "பணப்புழக்க பகுப்பாய்வு",
    transactions: "பரிவர்த்தனை CSV",
    payments: "கட்டணங்கள் மற்றும் நினைவூட்டல்கள்",
    history: "பகுப்பாய்வு வரலாறு",
    language: "மொழி",
    greeting: "நல்ல வணிகம் தொடங்குவது",
    run: "பகுப்பாய்வு செய்"
  },
  te: {
    overview: "అవలోకనం",
    analysis: "నగదు ప్రవాహ విశ్లేషణ",
    transactions: "లావాదేవీ CSV",
    payments: "చెల్లింపులు మరియు రిమైండర్లు",
    history: "విశ్లేషణ చరిత్ర",
    language: "భాష",
    greeting: "మంచి వ్యాపారం ప్రారంభమవుతుంది",
    run: "విశ్లేషణ ప్రారంభించండి"
  }
};

function applyLanguage(lang) {
  const t = translations[lang] || translations.en;

  document.querySelector('[data-tab="overview"]').lastChild.textContent = " " + t.overview;
  document.querySelector('[data-tab="analysis"]').lastChild.textContent = " " + t.analysis;
  document.querySelector('[data-tab="transactions"]').lastChild.textContent = " " + t.transactions;
  document.querySelector('[data-tab="payments"]').lastChild.textContent = " " + t.payments;
  document.querySelector('[data-tab="history"]').lastChild.textContent = " " + t.history;

  const h = document.querySelector(".topbar h1");
  if (h) h.innerHTML = `${t.greeting} <em>cash clarity.</em>`;

  $("heroAnalyze").innerHTML = `${t.run} <span>↗</span>`;
  document.documentElement.lang = lang;
}

$("languageSelect").addEventListener("change", e => applyLanguage(e.target.value));

function playAlertSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.18);

    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.38);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => ctx.close();
  } catch (error) {
    console.warn("Browser sound unavailable", error);
  }
}

$("soundToggle").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  $("soundToggle").textContent =
    soundEnabled ? "🔔 Sound alerts: On" : "🔕 Sound alerts: Off";
  $("soundToggle").setAttribute("aria-pressed", String(soundEnabled));

  if (soundEnabled) playAlertSound();
});

// ==========================================
// COGNITO SESSION RESTORATION
// ==========================================

$("dashboardSignout").addEventListener("click", signOutCognito);

async function restoreCognitoSession() {
  try {
    const response = await fetch("/auth/me", {
      credentials: "same-origin"
    });

    if (!response.ok) {
      showScreen("welcomeScreen");
      return;
    }

    const data = await response.json();
    const user = data.user;

    $("signedInName").textContent = user.name || user.email;

    $("avatar").textContent = (user.name || user.email)
      .split(/\s+/)
      .map(part => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

    $("analysisForm").elements.businessId.value = user.id;
    $("paymentBusinessId").value = user.id;

    showScreen("dashboard");

    await Promise.all([
      loadConfig(),
      loadHistory(),
      loadPayments()
    ]);

  } catch (error) {
    console.error("Cognito session restoration failed:", error);
    showScreen("welcomeScreen");
  }
}

checkHealth();
restoreCognitoSession();

// ==========================================
// INTEGRATED BEDROCK-POWERED AI COPILOT
// ==========================================

const copilotForm = $("copilotForm");

function addCopilotMessage(text, role = "bot", error = false) {
  const el = document.createElement("div");
  el.className = `copilot-message ${role}${error ? " error" : ""}`;
  el.textContent = text;

  $("copilotMessages").appendChild(el);
  $("copilotMessages").scrollTop = $("copilotMessages").scrollHeight;

  return el;
}

async function askCopilot(question) {
  const send = $("copilotSend");
  send.disabled = true;

  const pending = addCopilotMessage("Thinking…");

  try {
    const context = {};

    if (latestAnalysis) {
      context.latestAnalysis = latestAnalysis;
    }

    if (paymentItems?.length) {
      context.paymentSummary = {
        invoiceCount: paymentItems.length,
        totalAmount: paymentItems.reduce(
          (sum, p) => sum + Number(p.totalAmount || 0), 0
        ),
        totalPaid: paymentItems.reduce(
          (sum, p) => sum + Number(p.amountPaid || 0), 0
        ),
        totalDue: paymentItems.reduce(
          (sum, p) =>
            sum + Number(
              p.amountDue ??
              Math.max(0, Number(p.totalAmount || 0) - Number(p.amountPaid || 0))
            ), 0
        )
      };
    }

    const result = await request("/api/copilot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, context })
    });

    pending.textContent = result.answer || "No answer returned.";

  } catch (error) {
    pending.textContent = error.message;
    pending.classList.add("error");
  } finally {
    send.disabled = false;
  }
}

copilotForm.addEventListener("submit", async event => {
  event.preventDefault();

  const input = $("copilotQuestion");
  const question = input.value.trim();

  if (!question) return;

  addCopilotMessage(question, "user");
  input.value = "";

  await askCopilot(question);
});

document.querySelectorAll(".copilot-prompt").forEach(button => {
  button.addEventListener("click", () => {
    const question = button.dataset.prompt;
    addCopilotMessage(question, "user");
    askCopilot(question);
  });
});
