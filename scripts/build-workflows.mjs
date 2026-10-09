// Writes the example workflows in workflows/*.json. The support inbox workflow asks exactly the questions in
// eval/questions.mjs, the ones measured in eval/results.md.
//
//   node scripts/build-workflows.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPPORT_QUESTIONS } from '../eval/questions.mjs';

const OUT = fileURLToPath(new URL('../workflows/', import.meta.url));
export const JEV_TYPE = 'n8n-nodes-jev.jevDecision';
export const CREDENTIAL = { id: 'jevTypeSafeCred1', name: 'TypeSafe account' };

const uuid = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function node(wf, name, type, typeVersion, position, parameters = {}, extra = {}) {
  return { parameters, id: uuid(`${wf}:${name}`), name, type, typeVersion, position, ...extra };
}

const trigger = (wf) => node(wf, 'Try with sample data', 'n8n-nodes-base.manualTrigger', 1, [0, 300]);

const sample = (wf, name, rows) =>
  node(wf, name, 'n8n-nodes-base.code', 2, [220, 300], {
    jsCode: `// Invented sample data. In production, replace this node with your real trigger.\nreturn ${JSON.stringify(rows, null, 2)}.map((json) => ({ json }));`,
  });

const placeholder = (wf, name, position, note) =>
  node(wf, name, 'n8n-nodes-base.noOp', 1, position, {}, { notes: note, notesInFlow: true });

const sticky = (wf, content, position, size = [420, 300]) =>
  node(wf, 'About this workflow', 'n8n-nodes-base.stickyNote', 1, position, {
    content,
    height: size[1],
    width: size[0],
    color: 4,
  });

function jev(wf, position, parameters) {
  return node(wf, 'Jev Decision', JEV_TYPE, 1, position, parameters, {
    credentials: { typeSafeApi: CREDENTIAL },
  });
}

const criteriaText = (q) =>
  q.type === 'choice'
    ? Object.entries(q.options)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : q.type === 'score'
      ? q.levels.join('\n')
      : [q.yes ? `yes: ${q.yes}` : '', q.no ? `no: ${q.no}` : ''].filter(Boolean).join('\n');

const severalQuestions = (questions) => ({
  question: questions.map((q) => ({
    key: q.key,
    type: q.type,
    instructions: q.instructions,
    criteria: criteriaText(q),
    threshold: q.threshold ?? 0,
    gate: q.gate !== false,
  })),
});

function condition(wf, id, leftValue, operator, rightValue = '') {
  return { id: uuid(`${wf}:cond:${id}`), leftValue, rightValue, operator };
}

function ifNode(wf, name, position, conditions) {
  return node(wf, name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions,
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  });
}

function switchNode(wf, name, position, field, outputs) {
  return node(wf, name, 'n8n-nodes-base.switch', 3.2, position, {
    rules: {
      values: outputs.map(([value, label]) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [condition(wf, `switch-${value}`, field, { type: 'string', operation: 'equals' }, value)],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: label,
      })),
    },
    options: {},
  });
}

const link = (to, index = 0) => ({ node: to, type: 'main', index });

function workflow(id, name, description, nodes, connections) {
  return {
    name,
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
    active: false,
    id,
    versionId: uuid(`${id}:version`),
    description,
  };
}

// 1. Support inbox routing ---------------------------------------------------------------------------------------
function supportRouting() {
  const wf = 'support';
  const questions = [
    ...SUPPORT_QUESTIONS,
    {
      key: 'refund',
      type: 'noul',
      instructions: 'Does the customer ask for money back (a refund, a credit or a reversed charge)?',
      // Recorded on every ticket but never holds one back: a person checks refunds anyway.
      gate: false,
    },
  ];
  const emails = [
    { from: 'maya@greenleaf.example', subject: 'Charged twice this month', body: 'Our card shows two charges of $49 for October. Please refund the duplicate.' },
    { from: 'ops@harbourcafe.example', subject: 'Locked out before payroll', body: 'Nobody can sign in since we turned on single sign-on, and payroll for 22 staff has to go out by 2pm today.' },
    { from: 'li.wei@northfield.example', subject: 'Bank feed stopped', body: 'The bank feed has not imported anything since Friday. Month end is in two weeks so no panic.' },
    { from: 'sam@brightpath.example', subject: 'Pricing for 40 seats', body: 'We are comparing tools. What would 40 users on annual billing cost, and do you have a nonprofit price?' },
    { from: 'finance@atlasbuild.example', subject: 'Question', body: 'Can you help with the thing from last week? Same as before.' },
    { from: 'jo@riverside.example', subject: 'Exports and a refund?', body: 'The CSV export cuts off at 10,000 rows, and since we cannot use it, can we get some money back for this month?' },
  ];
  const nodes = [
    sticky(
      wf,
      '## Support inbox routing\nJev reads each email once and answers three questions: which **team**, is it **urgent**, does it ask for a **refund**.\n\nConfident answers go straight to the team queue. Anything Jev is unsure about goes to a person.\n\nReplace **Sample inbox** with your email trigger and the queue nodes with your helpdesk.',
      [-40, -60],
      [460, 260],
    ),
    trigger(wf),
    sample(wf, 'Sample inbox', emails),
    jev(wf, [460, 300], {
      operation: 'askSeveral',
      stateSource: 'expression',
      state: '=Subject: {{ $json.subject }}\n\n{{ $json.body }}',
      questions: severalQuestions(questions),
      threshold: 0.8,
      additionalOptions: { includeAudit: true, redactPersonalData: true },
    }),
    switchNode(wf, 'Send to team', [740, 200], '={{ $json.jev.answers.team.answer }}', [
      ['billing', 'Billing'],
      ['technical', 'Technical'],
      ['account', 'Account'],
      ['sales', 'Sales'],
    ]),
    placeholder(wf, 'Billing queue', [1000, -60], 'Placeholder: create the ticket in your helpdesk'),
    placeholder(wf, 'Technical queue', [1000, 120], 'Placeholder: create the ticket in your helpdesk'),
    placeholder(wf, 'Account queue', [1000, 300], 'Placeholder: create the ticket in your helpdesk'),
    placeholder(wf, 'Sales queue', [1000, 480], 'Placeholder: hand the lead to sales'),
    placeholder(wf, 'Triage list', [740, 560], 'Placeholder: a person picks the team'),
  ];
  const connections = {
    'Try with sample data': { main: [[link('Sample inbox')]] },
    'Sample inbox': { main: [[link('Jev Decision')]] },
    'Jev Decision': { main: [[link('Send to team')], [link('Triage list')]] },
    'Send to team': { main: [[link('Billing queue')], [link('Technical queue')], [link('Account queue')], [link('Sales queue')]] },
  };
  return workflow('jevSupportRoute1', 'Jev: support inbox routing', 'Routes support emails to a team queue when Jev is confident, and to a person when it is not.', nodes, connections);
}

// 2. Incident and alert triage -----------------------------------------------------------------------------------
function incidentTriage() {
  const wf = 'incident';
  const alerts = [
    { source: 'monitoring', title: 'Checkout error rate 38% (threshold 2%)', details: 'payments-api 5xx spike since 09:12 UTC across all regions. Card payments failing for customers.' },
    { source: 'monitoring', title: 'Nightly warehouse export 40 min late', details: 'data-export job still running. Downstream finance dashboard will refresh late. No customer impact.' },
    { source: 'support', title: 'Several customers cannot log in', details: '12 tickets in 20 minutes: "invalid session" after login on the web app. Mobile seems fine.' },
    { source: 'monitoring', title: 'Disk 81% on build runner 3', details: 'ci-runner-3 disk usage crossed 80%. Builds still passing.' },
    { source: 'chat', title: 'something feels off', details: 'A few things look slower than usual? Not sure where.' },
  ];
  const nodes = [
    sticky(
      wf,
      '## Incident and alert triage\nFor every alert Jev picks the **service area**, scores **severity** (SEV4 to SEV1) and says whether it is a **customer-facing outage**.\n\nConfident customer-facing alerts at SEV2 or above page on-call. Other confident alerts become tickets. Unclear alerts go to the on-call channel for a human look.',
      [-40, -60],
      [460, 260],
    ),
    trigger(wf),
    sample(wf, 'Sample alerts', alerts),
    jev(wf, [460, 300], {
      operation: 'askSeveral',
      stateSource: 'item',
      questions: severalQuestions([
        {
          key: 'area',
          type: 'choice',
          instructions: 'Which service area does this alert belong to?',
          options: {
            payments: 'Checkout, card payments, billing services',
            auth: 'Login, sessions, single sign-on, user accounts',
            api: 'Public API and webhooks',
            web_app: 'The web or mobile app front end',
            data: 'Data pipelines, exports, reporting jobs',
            infrastructure: 'Servers, disks, networks, build and deploy systems',
          },
        },
        {
          key: 'severity',
          type: 'score',
          instructions: 'How severe is this incident?',
          levels: [
            'SEV4: no user impact, housekeeping',
            'SEV3: minor or internal impact, a workaround exists',
            'SEV2: a major feature is degraded for some customers',
            'SEV1: a core service is down or failing for most customers',
          ],
        },
        {
          key: 'customer_facing',
          type: 'noul',
          instructions: 'Is this a customer-facing outage happening now?',
          yes: 'Customers cannot use part of the product right now',
          no: 'Internal only, or a warning with no customer impact yet',
        },
      ]),
      threshold: 0.7,
      additionalOptions: { includeAudit: true },
    }),
    ifNode(wf, 'Page on-call?', [740, 200], [
      condition(wf, 'facing', '={{ $json.jev.answers.customer_facing.answer }}', { type: 'boolean', operation: 'true', singleValue: true }),
      condition(wf, 'sev', '={{ $json.jev.answers.severity.level }}', { type: 'number', operation: 'gte' }, 2),
    ]),
    placeholder(wf, 'Page on-call', [1000, 100], 'Placeholder: your paging tool'),
    placeholder(wf, 'Create ticket', [1000, 300], 'Placeholder: your issue tracker'),
    placeholder(wf, 'On-call channel', [740, 520], 'Placeholder: a person triages it'),
  ];
  const connections = {
    'Try with sample data': { main: [[link('Sample alerts')]] },
    'Sample alerts': { main: [[link('Jev Decision')]] },
    'Jev Decision': { main: [[link('Page on-call?')], [link('On-call channel')]] },
    'Page on-call?': { main: [[link('Page on-call')], [link('Create ticket')]] },
  };
  return workflow('jevIncidentTri01', 'Jev: incident and alert triage', 'Pages on-call for confident customer-facing incidents and sends unclear alerts to a person.', nodes, connections);
}

// 3. Inbound lead scoring ----------------------------------------------------------------------------------------
function leadScoring() {
  const wf = 'leads';
  const leads = [
    { name: 'Dana Whitfield', company: 'Copperline Logistics', size: '120 staff', message: 'Our finance team of 6 needs approvals and multi-currency. Budget approved, we want to start next month. Can we see a demo this week?' },
    { name: 'Tom Okafor', company: 'Self-employed', size: '1', message: 'just looking around, is there a free version?' },
    { name: 'Rhea Lindqvist', company: 'Bluefin Dental Group', size: '45 staff, 4 clinics', message: 'We are reviewing tools for next year. Could you send a brochure and pricing for 8 users?' },
    { name: 'Marcus Bell', company: 'Northgate Studios', size: '30 staff', message: 'Our contract with our current provider ends in 3 weeks. We need payroll for 30 people and a quote today if possible.' },
    { name: 'Win a free cruise', company: '-', size: '-', message: 'Click here to claim your prize now!!!' },
  ];
  const nodes = [
    sticky(
      wf,
      '## Inbound lead scoring\nJev **scores fit** (0 to 3) and picks the **buying intent** of each website enquiry in one call.\n\nConfident hot leads (good fit and ready to buy) go to the CRM. Everything else goes to a review list for the sales team.',
      [-40, -60],
      [460, 240],
    ),
    trigger(wf),
    sample(wf, 'Sample enquiries', leads),
    jev(wf, [460, 300], {
      operation: 'askSeveral',
      stateSource: 'item',
      questions: severalQuestions([
        {
          key: 'fit',
          type: 'score',
          instructions: 'How well does this company fit a bookkeeping and payroll product for small and mid-sized businesses?',
          levels: [
            'No fit: spam, a job seeker, or not a business',
            'Weak fit: a sole trader or hobby use',
            'Good fit: a small business with a finance need',
            'Strong fit: a growing business with several finance users and a clear need such as payroll or approvals',
          ],
        },
        {
          key: 'intent',
          type: 'choice',
          instructions: 'How ready to buy is this person?',
          options: {
            buying_now: 'Wants to buy or start soon: asks for a demo, a quote, or names a date',
            evaluating: 'Comparing options or gathering information for later',
            browsing: 'Casual interest, no clear need',
            not_a_lead: 'Spam, a job application, or a supplier pitch',
          },
        },
      ]),
      threshold: 0.6,
      additionalOptions: { includeAudit: true },
    }),
    ifNode(wf, 'Hot lead?', [740, 200], [
      condition(wf, 'fit', '={{ $json.jev.answers.fit.level }}', { type: 'number', operation: 'gte' }, 2),
      condition(wf, 'intent', '={{ $json.jev.answers.intent.answer }}', { type: 'string', operation: 'equals' }, 'buying_now'),
    ]),
    placeholder(wf, 'Add to CRM', [1000, 100], 'Placeholder: your CRM node'),
    placeholder(wf, 'Review list', [1000, 420], 'Placeholder: a sheet or table for sales'),
  ];
  const connections = {
    'Try with sample data': { main: [[link('Sample enquiries')]] },
    'Sample enquiries': { main: [[link('Jev Decision')]] },
    'Jev Decision': { main: [[link('Hot lead?')], [link('Review list')]] },
    'Hot lead?': { main: [[link('Add to CRM')], [link('Review list')]] },
  };
  return workflow('jevLeadScoring01', 'Jev: inbound lead scoring', 'Sends confident hot leads to the CRM and everything else to a review list.', nodes, connections);
}

export const WORKFLOWS = { 'support-inbox-routing': supportRouting, 'incident-triage': incidentTriage, 'lead-scoring': leadScoring };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  for (const [slug, build] of Object.entries(WORKFLOWS)) {
    writeFileSync(`${OUT}${slug}.json`, `${JSON.stringify(build(), null, 2)}\n`);
    console.log(`wrote workflows/${slug}.json`);
  }
}
