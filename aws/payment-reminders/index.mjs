import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const TABLE_NAME = process.env.PAYMENTS_TABLE || "CashFlowPayments";
const FROM_EMAIL = process.env.SES_FROM_EMAIL;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ses = new SESv2Client({ region: REGION });
const dateOnly = (date) => date.toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export const handler = async (event = {}) => {
  if (!FROM_EMAIL) throw new Error("Set SES_FROM_EMAIL on this Lambda and verify it in Amazon SES.");
  const today = dateOnly(new Date());
  let scanned = 0, sent = 0, skipped = 0, errors = 0;
  const result = await db.send(new ScanCommand({ TableName: TABLE_NAME }));
  for (const p of result.Items || []) {
    scanned++;
    try {
      const total = Number(p.totalAmount || 0);
      const paid = Number(p.amountPaid || 0);
      const due = Math.max(0, Number(p.amountDue ?? (total - paid)));
      if (!p.businessId || !p.paymentId || !p.dueDate || !p.recipientEmail || due <= 0 || String(p.status).toUpperCase() === "PAID") { skipped++; continue; }
      const daysUntilDue = dayDiff(today, p.dueDate); // positive = future
      const startDays = Number.isFinite(Number(p.reminderStartDays)) ? Number(p.reminderStartDays) : 7;
      let shouldSend = false;
      let reminderType = "upcoming";
      if (daysUntilDue >= 0 && daysUntilDue <= startDays) {
        shouldSend = p.lastUpcomingReminderDate !== today; // once per day
      } else if (daysUntilDue < 0) {
        reminderType = "overdue";
        const last = p.lastOverdueReminderDate || "";
        shouldSend = !last || dayDiff(last, today) >= 7; // once every 7 days after due date
      }
      if (!shouldSend) { skipped++; continue; }
      const currency = p.currency || "INR";
      const amount = (n) => `${currency} ${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
      const message = [
        `CashFlow Sentinel ${reminderType === "overdue" ? "OVERDUE PAYMENT REMINDER" : "PAYMENT DUE REMINDER"}`,
        `Business: ${p.businessName || p.businessId}`,
        `Invoice: ${p.invoiceId || p.paymentId}`,
        `Payment ID: ${p.paymentId}`,
        `Details: ${p.description || "—"}`,
        `Due date: ${p.dueDate}`,
        `Total amount: ${amount(total)}`,
        `Amount paid: ${amount(paid)}`,
        `Outstanding amount: ${amount(due)}`,
        `Payment status: ${p.status || (paid > 0 ? "PARTIALLY_PAID" : "UNPAID")}`,
        `Reminder email on record: ${p.recipientEmail}`,
        `Receipt records: ${(p.receiptKeys || []).length}`,
        "If you have already paid, update the payment record and keep the receipt for your records. This reminder is not proof of a transaction."
      ].join("\n");
      await ses.send(new SendEmailCommand({
        FromEmailAddress: FROM_EMAIL,
        Destination: { ToAddresses: [p.recipientEmail] },
        Content: { Simple: {
          Subject: { Data: `${reminderType === "overdue" ? "Overdue" : "Due soon"}: ${p.invoiceId || p.paymentId}`.slice(0, 100) },
          Body: { Text: { Data: message } }
        } }
      }));
      const update = reminderType === "overdue"
        ? "SET lastOverdueReminderDate = :d"
        : "SET lastUpcomingReminderDate = :d";
      await db.send(new UpdateCommand({ TableName: TABLE_NAME, Key: { businessId: p.businessId, paymentId: p.paymentId }, UpdateExpression: update, ExpressionAttributeValues: { ":d": today } }));
      sent++;
    } catch (err) {
      errors++;
      console.error("Reminder failed for payment", p.paymentId, err.name, err.message);
    }
  }
  const body = { message: "Payment reminder check completed", date: today, scanned, sent, skipped, errors, eventAction: event.action || "scheduled" };
  console.log(JSON.stringify(body));
  return { statusCode: 200, body: JSON.stringify(body) };
};
