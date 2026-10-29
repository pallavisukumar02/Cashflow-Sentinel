# Importing the enhanced financial CSV

The Payments & Reminders panel can import invoice rows using these columns:
- `business_id`, `business_name`, `payment_id`, `due_date`
- `total_amount_inr`, `amount_paid_inr`, `balance_due_inr`, `payment_status`
- `recipient_email` (required for email reminders)

The app maps the uploaded schema to the `CashFlowPayments` DynamoDB record format. The chart reads the records after successful import. This sample dataset is synthetic; replace `recipient_email` with an address you control before importing. Fully paid records do not generate reminders. Unpaid/partially paid records are eligible only when the due date, email, SES configuration, and AWS permissions are valid.

Importing writes records to AWS DynamoDB; it does not itself create or change EventBridge schedules. Keep the existing enabled `cashflow-daily-payment-reminders` schedule targeting `cashflow-sentinel-reminders`, and verify it in AWS before relying on delivery.
