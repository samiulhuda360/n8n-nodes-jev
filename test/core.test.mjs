import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../dist/nodes/JevDecision/core.js');

test('builds one request with every question type', () => {
  const body = core.buildRequest('Card charged twice', [
    { key: 'team', type: 'choice', instructions: 'Which team?', options: { billing: 'Charges', technical: null } },
    { key: 'anger', type: 'score', instructions: 'How angry?', levels: ['Calm', 'Annoyed', 'Furious'] },
    { key: 'urgent', type: 'noul', instructions: 'Is it urgent?', yes: 'Same-day deadline' },
  ]);
  assert.deepEqual(body, {
    model: 'jev-latest',
    state: 'Card charged twice',
    questions: {
      team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', technical: null } },
      anger: { type: 'score', instructions: 'How angry?', criteria: ['Calm', 'Annoyed', 'Furious'] },
      urgent: { type: 'noul', instructions: 'Is it urgent?', criteria: { true: 'Same-day deadline' } },
    },
  });
});

test('a noul without criteria sends none', () => {
  const body = core.buildRequest({ subject: 'x' }, [{ key: 'q', type: 'noul', instructions: 'Yes?' }], 'jev-preview');
  assert.deepEqual(body.questions.q, { type: 'noul', instructions: 'Yes?' });
  assert.equal(body.model, 'jev-preview');
  assert.deepEqual(body.state, { subject: 'x' });
});

test('rejects bad questions with readable messages', () => {
  const bad = [
    [[{ key: 'a', type: 'choice', instructions: 'x', options: { only: null } }], /at least two options/],
    [[{ key: 'a', type: 'score', instructions: 'x', levels: ['one'] }], /at least two levels/],
    [[{ key: 'a', type: 'score', instructions: 'x', levels: Array(11).fill('l') }], /at most 10/],
    [[{ key: 'a', type: 'noul', instructions: '  ' }], /needs instructions/],
    [[{ key: '1bad', type: 'noul', instructions: 'x' }], /must start with a letter/],
    [[{ key: 'a', type: 'noul', instructions: 'x' }, { key: 'a', type: 'noul', instructions: 'y' }], /Two questions/],
    [[{ key: 'a', type: 'noul', instructions: 'x', threshold: 1.5 }], /between 0 and 1/],
    [[], /at least one question/],
  ];
  for (const [specs, message] of bad) assert.throws(() => core.buildRequest('state', specs), message);
  assert.throws(() => core.buildRequest('   ', [{ key: 'a', type: 'noul', instructions: 'x' }]), /state is empty/);
});

test('parses option and level lines', () => {
  assert.deepEqual(core.parseOptionLines('billing: Charges, refunds\n\ntechnical:Bugs\nsales'), {
    billing: 'Charges, refunds',
    technical: 'Bugs',
    sales: null,
  });
  assert.throws(() => core.parseOptionLines('a\na'), /listed twice/);
  assert.deepEqual(core.parseLevelLines(' Low \n\nHigh\n'), ['Low', 'High']);
});

test('confidence formulas match the documented examples', () => {
  assert.equal(core.choiceConfidence([0.6, 0.3, 0.1]).toFixed(2), '0.40');
  assert.equal(core.choiceConfidence([0.6, 0.2, 0.2]).toFixed(2), '0.40');
  assert.equal(core.choiceConfidence([0.25, 0.25, 0.25, 0.25]), 0);
  assert.equal(core.scoreConfidence([0, 0.95, 0.05]).toFixed(3), '0.925');
  assert.equal(core.noulConfidence(0.5), 0);
  assert.equal(core.noulConfidence(0.95).toFixed(2), '0.90');
  assert.equal(core.noulConfidence(0.05).toFixed(2), '0.90');
});

test('reads typed answers and applies thresholds', () => {
  const choice = core.readAnswer(
    { key: 'team', type: 'choice', instructions: 'x', options: {} },
    { choice: 'billing', confidence: 0.81, probabilities: { billing: 0.88, technical: 0.12 } },
    0.8,
  );
  assert.equal(choice.answer, 'billing');
  assert.equal(choice.passed, true);

  const score = core.readAnswer(
    { key: 'fit', type: 'score', instructions: 'x', levels: ['Poor', 'OK', 'Great'], threshold: 0.95 },
    { score: 1.05, confidence: 0.92, legend: { 0: 'Poor', 1: 'OK', 2: 'Great' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 } },
    0.5,
  );
  assert.equal(score.answer, 1.05);
  assert.equal(score.level, 1);
  assert.equal(score.label, 'OK');
  assert.equal(score.threshold, 0.95);
  assert.equal(score.passed, false);

  const noul = core.readAnswer({ key: 'urgent', type: 'noul', instructions: 'x' }, { noul: 0.12 }, 0.7);
  assert.equal(noul.answer, false);
  assert.equal(noul.probability, 0.12);
  assert.equal(noul.confidence, 0.76);
  assert.equal(noul.passed, true);
  assert.throws(() => core.readAnswer({ key: 'gone', type: 'noul', instructions: 'x' }, undefined, 0.5), /no answer/);
});

test('routes on the weakest gating answer and ignores non-gating ones', () => {
  const d = (key, confidence, passed, gate = true) => ({ key, confidence, passed, gate });
  assert.deepEqual(core.route([d('a', 0.9, true), d('b', 0.85, true)]), { route: 'confident', confidence: 0.85, below: [] });
  assert.deepEqual(core.route([d('a', 0.9, true), d('b', 0.4, false)]), { route: 'review', confidence: 0.4, below: ['b'] });
  assert.deepEqual(core.route([d('a', 0.9, true), d('b', 0.4, false, false)]), { route: 'confident', confidence: 0.9, below: [] });
});

test('audit records carry question, answer, confidence, model and time', () => {
  const specs = [{ key: 'urgent', type: 'noul', instructions: 'Is it urgent?' }];
  const decisions = [core.readAnswer(specs[0], { noul: 0.97 }, 0.8)];
  const [record] = core.auditRecords(specs, decisions, core.route(decisions), 'jev-1.13.0', '2026-01-01T00:00:00.000Z', {
    workflowId: 'wf1',
  });
  assert.deepEqual(record, {
    timestamp: '2026-01-01T00:00:00.000Z',
    question: 'urgent',
    type: 'noul',
    instructions: 'Is it urgent?',
    answer: true,
    confidence: 0.94,
    threshold: 0.8,
    passed: true,
    route: 'confident',
    model: 'jev-1.13.0',
    workflowId: 'wf1',
  });
});

test('redacts personal data and reads nested fields', () => {
  assert.equal(
    core.redact('Mail jo.bloggs@example.com or call +44 20 7946 0958, card 4111 1111 1111 1111'),
    'Mail [email] or call [phone], card [card]',
  );
  assert.deepEqual(core.redact({ from: 'a@b.io', n: 3 }), { from: '[email]', n: 3 });
  assert.equal(core.getPath({ email: { parts: [{ text: 'hi' }] } }, 'email.parts[0].text'), 'hi');
  assert.equal(core.getPath({}, 'a.b'), undefined);
  assert.equal(core.truncate('abcdef', 3), 'abc');
  assert.equal(core.truncate('abcdef', 0), 'abcdef');
});

test('redaction leaves dates, amounts and invoice numbers alone', () => {
  const text = 'Invoice INV-1043 dated 2026-10-09 for $1,200.00, ref 55812';
  assert.equal(core.redact(text), text);
  assert.equal(core.redact('call (020) 7946 0958 today'), 'call [phone] today');
});
