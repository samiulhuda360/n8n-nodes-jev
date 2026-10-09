// Runs the node's execute() with a stand-in for n8n's execution context and a fake Jev endpoint.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { JevDecision } = require('../dist/nodes/JevDecision/JevDecision.node.js');
const { TypeSafeApi } = require('../dist/credentials/TypeSafeApi.credentials.js');

function context({ items, params, reply, continueOnFail = false }) {
  const calls = [];
  return {
    calls,
    getInputData: () => items.map((json) => ({ json })),
    getNodeParameter: (name, i, fallback) => {
      const value = params[name];
      if (value === undefined) return fallback;
      return typeof value === 'function' ? value(i) : value;
    },
    getCredentials: async () => ({ apiKey: 'test-key-not-real', baseUrl: 'https://jev.example.test/' }),
    getNode: () => ({ name: 'Jev Decision', type: 'n8n-nodes-jev.jevDecision', typeVersion: 1, parameters: {} }),
    getWorkflow: () => ({ id: 'wf-1', name: 'Test', active: false }),
    getExecutionId: () => 'exec-9',
    continueOnFail: () => continueOnFail,
    helpers: {
      httpRequestWithAuthentication: async (credentialType, request) => {
        calls.push({ credentialType, request });
        return reply(request.body, calls.length);
      },
    },
  };
}

const ticketReply = (body) => {
  const sure = String(body.state).includes('charged twice');
  return {
    model: 'jev-1.13.0',
    answers: {
      team: {
        type: 'choice',
        choice: sure ? 'billing' : 'technical',
        confidence: sure ? 0.95 : 0.4,
        probabilities: sure ? { billing: 0.96, technical: 0.04 } : { technical: 0.7, billing: 0.3 },
      },
      urgent: { type: 'noul', noul: sure ? 0.97 : 0.5 },
    },
    usage: { input_tokens: 300, output_tokens: 40 },
  };
};

const noulParams = (extra = {}) => ({
  operation: 'askNoul',
  stateSource: 'field',
  stateField: 'text',
  questionKey: 'q',
  instructions: 'x',
  threshold: 0.5,
  ...extra,
});

test('the description declares two outputs and the credential', () => {
  const d = new JevDecision().description;
  assert.deepEqual(d.outputNames, ['Confident', 'Needs review']);
  assert.equal(d.outputs.length, 2);
  assert.equal(d.credentials[0].name, 'typeSafeApi');
  const cred = new TypeSafeApi();
  assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
  assert.equal(cred.test.request.url, '/v1/models');
});

test('ask several: one call per item, split by confidence, audit added', async () => {
  const ctx = context({
    items: [
      { id: 1, body: 'I was charged twice this morning, fix it today' },
      { id: 2, body: 'Something seems off' },
    ],
    params: {
      operation: 'askSeveral',
      stateSource: 'field',
      stateField: 'body',
      threshold: 0.8,
      questions: {
        question: [
          { key: 'team', type: 'choice', instructions: 'Which team?', criteria: 'billing: Charges\ntechnical: Bugs', gate: true },
          { key: 'urgent', type: 'noul', instructions: 'Is it urgent?', criteria: '', threshold: 0, gate: true },
        ],
      },
      additionalOptions: { includeAudit: true },
    },
    reply: ticketReply,
  });
  const [confident, review] = await new JevDecision().execute.call(ctx);
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[0].credentialType, 'typeSafeApi');
  assert.equal(ctx.calls[0].request.url, 'https://jev.example.test/v1/systemone');
  assert.deepEqual(Object.keys(ctx.calls[0].request.body.questions), ['team', 'urgent']);

  assert.equal(confident.length, 1);
  assert.equal(review.length, 1);
  const hot = confident[0].json;
  assert.equal(hot.id, 1);
  assert.equal(hot.jev.route, 'confident');
  assert.equal(hot.jev.answers.team.answer, 'billing');
  assert.equal(hot.jev.answers.urgent.answer, true);
  assert.equal(hot.jev.model, 'jev-1.13.0');
  assert.equal(hot.jev.audit.length, 2);
  assert.equal(hot.jev.audit[0].model, 'jev-1.13.0');
  assert.equal(hot.jev.audit[0].executionId, 'exec-9');
  assert.match(hot.jev.audit[0].timestamp, /^\d{4}-\d\d-\d\dT/);
  assert.equal(hot.jev.answer, undefined);
  assert.deepEqual(review[0].json.jev.below, ['team', 'urgent']);
  assert.deepEqual(review[0].pairedItem, { item: 1 });
});

test('ask choice from an expression, with redaction and a custom output field', async () => {
  const ctx = context({
    items: [{ subject: 'Refund' }],
    params: {
      operation: 'askChoice',
      stateSource: 'expression',
      state: 'From jo@example.com: I was charged twice',
      questionKey: 'team',
      instructions: 'Which team?',
      choiceOptions: { option: [{ name: 'billing', description: 'Charges' }, { name: 'technical', description: '' }] },
      threshold: 0.9,
      additionalOptions: { redactPersonalData: true, outputField: 'decision' },
    },
    reply: (body) => {
      assert.equal(body.state, 'From [email]: I was charged twice');
      assert.deepEqual(body.questions.team.criteria, { billing: 'Charges', technical: null });
      return ticketReply(body);
    },
  });
  const [confident] = await new JevDecision().execute.call(ctx);
  assert.equal(confident[0].json.decision.answer, 'billing');
  assert.equal(confident[0].json.decision.threshold, 0.9);
});

test('ask yes/no gates on the distance from 0.5', async () => {
  const run = async (p) => {
    const ctx = context({
      items: [{ text: 'x' }],
      params: noulParams({ questionKey: 'refund', threshold: 0.8 }),
      reply: () => ({ model: 'jev-1.13.0', answers: { refund: { type: 'noul', noul: p } } }),
    });
    const [confident, review] = await new JevDecision().execute.call(ctx);
    return confident.length ? ['confident', confident[0].json.jev.answer] : ['review', review[0].json.jev.answer];
  };
  assert.deepEqual(await run(0.95), ['confident', true]);
  assert.deepEqual(await run(0.05), ['confident', false]);
  assert.deepEqual(await run(0.85), ['review', true]);
  assert.deepEqual(await run(0.2), ['review', false]);
});

test('ask score sends levels and reports the most likely level', async () => {
  const ctx = context({
    items: [{ text: 'We have 400 seats and budget approved' }],
    params: {
      operation: 'askScore',
      stateSource: 'item',
      questionKey: 'fit',
      instructions: 'How well does this lead fit?',
      scoreLevels: { level: [{ description: 'Poor' }, { description: 'Fair' }, { description: 'Strong' }] },
      threshold: 0.6,
    },
    reply: (body) => {
      assert.deepEqual(body.state, { text: 'We have 400 seats and budget approved' });
      assert.deepEqual(body.questions.fit.criteria, ['Poor', 'Fair', 'Strong']);
      return {
        model: 'jev-1.13.0',
        answers: {
          fit: { type: 'score', score: 1.9, confidence: 0.85, legend: { 0: 'Poor', 1: 'Fair', 2: 'Strong' }, probabilities: { 0: 0, 1: 0.1, 2: 0.9 } },
        },
      };
    },
  });
  const [confident] = await new JevDecision().execute.call(ctx);
  assert.equal(confident[0].json.jev.answers.fit.level, 2);
  assert.equal(confident[0].json.jev.answers.fit.label, 'Strong');
});

test('errors stop the run, or go to Needs review with continue on fail', async () => {
  const params = noulParams({ stateField: 'missing' });
  const reply = () => ({ model: 'jev', answers: { q: { noul: 1 } } });
  await assert.rejects(new JevDecision().execute.call(context({ items: [{ text: 'a' }], params, reply })), /no field "missing"/);
  const [confident, review] = await new JevDecision().execute.call(context({ items: [{ text: 'a' }], params, reply, continueOnFail: true }));
  assert.equal(confident.length, 0);
  assert.match(review[0].json.jev.error, /no field "missing"/);
});

test('retries a rate limit, then succeeds', async () => {
  const ctx = context({
    items: [{ text: 'a' }],
    params: noulParams(),
    reply: (_body, n) => {
      if (n === 1) throw Object.assign(new Error('Too Many Requests'), { httpCode: '429' });
      return { model: 'jev-1.13.0', answers: { q: { noul: 0.99 } } };
    },
  });
  const [confident] = await new JevDecision().execute.call(ctx);
  assert.equal(ctx.calls.length, 2);
  assert.equal(confident.length, 1);
});

test('keeps item order inside each output when requests run in parallel', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ text: `item ${i}` }));
  const ctx = context({
    items,
    params: noulParams({ additionalOptions: { concurrency: 4 } }),
    reply: async (body) => {
      const n = Number(String(body.state).split(' ')[1]);
      await new Promise((r) => setTimeout(r, (12 - n) * 3));
      return { model: 'jev-1.13.0', answers: { q: { noul: n % 2 ? 0.99 : 0.5 } } };
    },
  });
  const [confident, review] = await new JevDecision().execute.call(ctx);
  assert.deepEqual(confident.map((x) => x.json.text), ['item 1', 'item 3', 'item 5', 'item 7', 'item 9', 'item 11']);
  assert.deepEqual(review.map((x) => x.json.text), ['item 0', 'item 2', 'item 4', 'item 6', 'item 8', 'item 10']);
});

test('ask several reads yes/no meanings and score levels from the text box', async () => {
  const ctx = context({
    items: [{ text: 'Checkout is failing for everyone' }],
    params: {
      operation: 'askSeveral',
      stateSource: 'field',
      stateField: 'text',
      threshold: 0.7,
      questions: {
        question: [
          { key: 'severity', type: 'score', instructions: 'How severe?', criteria: 'SEV4\nSEV3\nSEV2\nSEV1', threshold: 0.5, gate: true },
          { key: 'outage', type: 'noul', instructions: 'Customer-facing outage?', criteria: 'yes: Customers blocked now\nno: Internal only', gate: true },
        ],
      },
    },
    reply: (body) => {
      assert.deepEqual(body.questions.severity.criteria, ['SEV4', 'SEV3', 'SEV2', 'SEV1']);
      assert.deepEqual(body.questions.outage.criteria, { true: 'Customers blocked now', false: 'Internal only' });
      return {
        model: 'jev-1.13.0',
        answers: {
          severity: { type: 'score', score: 2.9, confidence: 0.6, probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.9 } },
          outage: { type: 'noul', noul: 0.96 },
        },
      };
    },
  });
  const [confident] = await new JevDecision().execute.call(ctx);
  assert.equal(confident.length, 1, 'severity passes its own 0.5 threshold, below the node 0.7');
  assert.equal(confident[0].json.jev.answers.severity.level, 3);
});
