import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildMessages, readLlmAnswers } from '../eval/backends/llm.mjs';
import { RulesBackend } from '../eval/backends/rules.mjs';
import { accuracy, automation, brierBinary, brierMulti, f1, macroF1, percentile, reliability } from '../eval/metrics.mjs';
import { SUPPORT_QUESTIONS } from '../eval/questions.mjs';

const workflow = (slug) => JSON.parse(readFileSync(new URL(`../workflows/${slug}.json`, import.meta.url), 'utf8'));

test('metrics on a small hand-checked example', () => {
  assert.equal(accuracy([1, 2, 3, 4], (x) => x > 2), 0.5);
  assert.equal(f1([[true, true], [true, false], [false, true], [false, false]]), 0.5);
  assert.equal(macroF1([['a', 'a'], ['b', 'b']], ['a', 'b']), 1);
  assert.equal(brierBinary([{ truth: true, probability: 0.8 }, { truth: false, probability: 0.4 }]).toFixed(2), '0.10');
  assert.equal(brierMulti([{ truth: 'a', probabilities: { a: 0.5, b: 0.5 } }]), 0.5);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95), 100);
  const bins = reliability([{ stated: 0.95, correct: true }, { stated: 0.95, correct: false }, { stated: 1, correct: true }]);
  assert.deepEqual(bins.map((b) => b.n), [0, 0, 0, 2, 1]);
  assert.equal(bins[3].accuracy, 0.5);
});

test('automation counts only items where every answer clears its threshold', () => {
  const rows = [
    { confidence: { team: 0.9, urgent: 0.9 }, correct: { team: true, urgent: true } },
    { confidence: { team: 0.9, urgent: 0.7 }, correct: { team: false, urgent: true } },
    { confidence: { team: 0.5, urgent: 0.9 }, correct: { team: true, urgent: true } },
  ];
  assert.deepEqual(automation(rows, 0.8, ['team', 'urgent']), { threshold: 0.8, automated: 1, rate: 1 / 3, accuracy: 1, wrongLetThrough: 0 });
  const mixed = automation(rows, { team: 0.8, urgent: 0.6 }, ['team', 'urgent']);
  assert.equal(mixed.automated, 2);
  assert.equal(mixed.wrongLetThrough, 1);
});

test('the chat model gets the same options and its JSON becomes the same answer shape', () => {
  const [, user] = buildMessages('Subject: x', SUPPORT_QUESTIONS);
  for (const team of Object.keys(SUPPORT_QUESTIONS[0].options)) assert.match(user.content, new RegExp(`- ${team}:`));
  const answers = readLlmAnswers({ team: { choice: 'billing', probability: '0.7' }, urgent: { probability: 0.2 } }, SUPPORT_QUESTIONS);
  assert.equal(answers.team.answer, 'billing');
  assert.equal(answers.team.probabilities.technical.toFixed(2), '0.10');
  assert.equal(answers.team.confidence.toFixed(2), '0.60');
  assert.equal(answers.urgent.answer, false);
  assert.equal(answers.urgent.confidence.toFixed(2), '0.60');
  const broken = readLlmAnswers({ team: { choice: 'nonsense' } }, SUPPORT_QUESTIONS);
  assert.equal(broken.team.confidence, 0);
  assert.equal(broken.urgent.probability, 0.5);
});

test('keyword rules: a clear hit, and no keywords means zero confidence', async () => {
  const rules = new RulesBackend();
  const hit = await rules.decide('I want a refund for the duplicate charge today, right now', SUPPORT_QUESTIONS);
  assert.equal(hit.decisions.team.answer, 'billing');
  assert.equal(hit.decisions.urgent.answer, true);
  const none = await rules.decide('Hello there', SUPPORT_QUESTIONS);
  assert.equal(none.decisions.team.answer, 'technical');
  assert.equal(none.decisions.team.confidence, 0);
  assert.equal(none.decisions.urgent.answer, false);
});

test('the support workflow asks exactly the evaluated questions', () => {
  const wf = workflow('support-inbox-routing');
  const jev = wf.nodes.find((n) => n.type === 'n8n-nodes-jev.jevDecision');
  const [team, urgent, refund] = jev.parameters.questions.question;
  assert.equal(team.instructions, SUPPORT_QUESTIONS[0].instructions);
  assert.equal(team.criteria.split('\n').length, Object.keys(SUPPORT_QUESTIONS[0].options).length);
  assert.equal(urgent.instructions, SUPPORT_QUESTIONS[1].instructions);
  assert.equal(urgent.criteria, `yes: ${SUPPORT_QUESTIONS[1].yes}\nno: ${SUPPORT_QUESTIONS[1].no}`);
  assert.equal(refund.gate, false);
  assert.equal(jev.credentials.typeSafeApi.name, 'TypeSafe account');
});

test('every example workflow is connected and uses the Jev node', () => {
  for (const slug of ['support-inbox-routing', 'incident-triage', 'lead-scoring']) {
    const wf = workflow(slug);
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-jev.jevDecision'), slug);
    for (const [from, { main }] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${slug}: ${from}`);
      for (const out of main) for (const link of out) assert.ok(names.has(link.node), `${slug}: ${link.node}`);
    }
    assert.equal(wf.connections['Jev Decision'].main.length, 2, `${slug}: both outputs wired`);
  }
});
