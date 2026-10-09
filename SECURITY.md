# Security

## What the node sends to the Jev API

For each item, the Jev Decision node makes one HTTPS request to `https://api.typesafe.ai/v1/systemone`, or to the
Base URL set on the credential. The request holds:

| Sent | Where it comes from |
|---|---|
| The **state**: the text or data Jev reads | The field you name, the expression you write, or the whole item, depending on **State From** |
| The **questions**: names, instructions, options, levels and yes/no descriptions | The node's settings |
| The **model** name, such as `jev-latest` | The node's **Model** option |
| Your **API key**, in the `Authorization` header | The TypeSafe API credential |

Nothing else from the item leaves n8n. With **State From: Field** or **Expression**, only that text is sent; the
other fields on the item stay in n8n. **Whole Item** sends every field on the item, so use it only on items you have
already trimmed.

The answers, confidence values and audit records are written back to the item inside n8n. Where they go next is up
to your workflow.

How TypeSafe stores and processes request data is set out in its own terms and policies:
https://docs.typesafe.ai/legal.

## Reducing what you send

- **Send one field, not the whole item.** Point **State From** at the message body, not the full record.
- **Turn on Redact Personal Data.** It replaces email addresses, phone numbers (9 or more digits) and card-like
  numbers (13 to 19 digits) with `[email]`, `[phone]` and `[card]` before the request is made. It is pattern
  matching, so it will not catch names, street addresses or account numbers in unusual formats.
- **Set Max State Length.** Long email threads repeat earlier messages and signatures. Cutting the state to the
  first 2,000 to 4,000 characters keeps the part that matters and sends less.
- **Clean up before the node.** A Code or Edit Fields node in front of Jev Decision can drop quoted replies,
  signatures, attachments and internal notes, or replace customer names with an ID.
- **Never put secrets in the state.** Passwords, API keys and one-time codes have no place in a classification
  request. If a source may contain them, filter it first.

## The API key

- Store the key in an n8n credential of type **TypeSafe API**. n8n encrypts saved credentials with
  `N8N_ENCRYPTION_KEY`; keep that value secret and the same across restarts.
- Share the credential only with the people and projects that need it (n8n's credential sharing settings).
- Give each environment (development, staging, production) its own key so one can be rotated without touching the
  others.
- To route traffic through an outbound proxy or API gateway, set the credential's **Base URL**.
- The credential test calls `GET /v1/models`, which reads no data and costs nothing.

## Audit records

With **Add Audit Record** on, every item carries one record per question: the question, the answer, the confidence,
the threshold, the route, the model version, a timestamp, and the workflow and execution IDs. The records contain the
question text but not the state. Send them to a database or sheet if you need a decision log; decide how long to keep
them under your own retention policy.

## Reporting a vulnerability

Please report security problems privately through GitHub's "Report a vulnerability" button on this repository
(Security tab), not in a public issue.

This project is independent and not affiliated with TypeSafe AI.
