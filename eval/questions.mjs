// The support-inbox questions. The evaluation and the "Support inbox routing" example workflow both use these,
// so the numbers in eval/results.md describe the questions the workflow really asks.

export const TEAMS = {
  billing:
    'An existing customer’s own subscription: charges, refunds, invoices or receipts from us, payment methods, plan changes, tax details on our invoices',
  technical:
    'The product not working or how to use a feature: errors, bugs, outages, slowness, bank feeds, imports, exports, reports, integrations, payroll calculations',
  account:
    'Access and users: logging in, passwords, two-factor, single sign-on, adding or removing users, roles and permissions, account ownership, security of the login',
  sales:
    'Someone who has not bought yet or wants a new contract: pricing questions before buying, quotes, demos, trials, discounts for new deals, partner or reseller programs',
};

export const SUPPORT_QUESTIONS = [
  {
    key: 'team',
    type: 'choice',
    instructions: 'Which team should handle this customer email?',
    options: TEAMS,
  },
  {
    key: 'urgent',
    type: 'noul',
    instructions:
      'Does this email need a reply within a few hours: the customer is blocked from working right now, reports a security problem, or faces a deadline today or by tomorrow morning?',
    yes: 'Blocked now, a security problem, or a deadline today or by tomorrow morning',
    no: 'An inconvenience, a question, or a deadline that is days or weeks away',
  },
];

/** The text Jev (and the comparison model) reads for one email. */
export function emailState(email) {
  return `Subject: ${email.subject}\n\n${email.body}`;
}
