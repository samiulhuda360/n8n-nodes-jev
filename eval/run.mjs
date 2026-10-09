// Compares Jev, a general chat model and keyword rules on 200 labelled support emails, and writes eval/results.md.
//
//   node eval/run.mjs                 replay recorded answers, call an API only for requests not recorded yet
//   node eval/run.mjs --offline       replay only (what CI runs); fails if a recording is missing
//   node eval/run.mjs --backends jev,rules --limit 20
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OfflineMiss } from './backends/cache.mjs';
import { JevBackend, PRICE as JEV_PRICE } from './backends/jev.mjs';
import { LlmBackend, PRICE as LLM_PRICE } from './backends/llm.mjs';
import { RulesBackend } from './backends/rules.mjs';
import { accuracy, automation, brierBinary, brierMulti, f1, macroF1, percentile, reliability } from './metrics.mjs';
import { SUPPORT_QUESTIONS, TEAMS, emailState } from './questions.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const offline = flag('offline');
const limit = Number(option('limit', 0));
const wanted = option('backends', 'jev,llm,rules').split(',');
const THRESHOLDS = [0.6, 0.8, 0.9];
// One per-question setting, the kind the node's "Own Threshold" field allows.
const MIXED = { team: 0.8, urgent: 0.6 };
const LABELS = Object.keys(TEAMS);

let emails = readFileSync(here('./data/support-emails.jsonl'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));
if (limit) emails = emails.slice(0, limit);

const backends = {
  jev: () => new JevBackend({ cachePath: here('./cache/jev.json'), offline }),
  llm: () => new LlmBackend({ cachePath: here('./cache/llm.json'), offline }),
  rules: () => new RulesBackend(),
};
const PRICES = { jev: JEV_PRICE, llm: LLM_PRICE, rules: { inputPerMillion: 0, outputPerMillion: 0 } };
const NAMES = { jev: 'Jev', llm: 'Gemini Flash-Lite (chat model)', rules: 'Keyword rules' };

const results = {};
const skipped = {};
for (const name of wanted) {
  const backend = backends[name]();
  const rows = [];
  try {
    for (const [i, email] of emails.entries()) {
      const out = await backend.decide(emailState(email), SUPPORT_QUESTIONS);
      const team = out.decisions.team;
      const urgent = out.decisions.urgent;
      rows.push({
        id: email.id,
        truth: { team: email.team, urgent: email.urgent },
        team,
        urgent,
        correct: { team: team.answer === email.team, urgent: urgent.answer === email.urgent },
        confidence: { team: team.confidence, urgent: urgent.confidence },
        latencyMs: out.latencyMs,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        model: out.model,
      });
      if (backend.liveCalls && (i + 1) % 25 === 0) console.log(`  ${name}: ${i + 1}/${emails.length}`);
    }
  } catch (error) {
    if (error instanceof OfflineMiss) {
      skipped[name] = error.message;
      console.log(`skipping ${name}: ${error.message}`);
      continue;
    }
    throw error;
  }
  // A full, live-capable run keeps the recordings in step with the dataset.
  if (!limit && !offline && backend.cache) {
    const dropped = backend.cache.prune();
    if (dropped) console.log(`  ${name}: dropped ${dropped} recordings no email uses any more`);
  }
  results[name] = { rows, liveCalls: backend.liveCalls };
  console.log(`${name}: ${rows.length} emails, ${backend.liveCalls} live calls`);
}

function summarise(name, rows) {
  const teamRows = rows.map((r) => ({ truth: r.truth.team, probabilities: r.team.probabilities }));
  const urgentRows = rows.map((r) => ({ truth: r.truth.urgent, probability: r.urgent.probability }));
  const inTok = rows.reduce((s, r) => s + r.inputTokens, 0);
  const outTok = rows.reduce((s, r) => s + r.outputTokens, 0);
  const price = PRICES[name];
  const costPerCall = (inTok * price.inputPerMillion + outTok * price.outputPerMillion) / 1e6 / rows.length;
  return {
    name,
    model: [...new Set(rows.map((r) => r.model))].join(', '),
    n: rows.length,
    teamAccuracy: accuracy(rows, (r) => r.correct.team),
    teamMacroF1: macroF1(rows.map((r) => [r.truth.team, r.team.answer]), LABELS),
    teamBrier: brierMulti(teamRows),
    urgentAccuracy: accuracy(rows, (r) => r.correct.urgent),
    urgentF1: f1(rows.map((r) => [r.truth.urgent, r.urgent.answer])),
    urgentBrier: brierBinary(urgentRows),
    bothCorrect: accuracy(rows, (r) => r.correct.team && r.correct.urgent),
    p50: percentile(rows.map((r) => r.latencyMs), 50),
    p95: percentile(rows.map((r) => r.latencyMs), 95),
    inputTokens: inTok,
    outputTokens: outTok,
    costPer1000: costPerCall * 1000,
    automation: {
      both: THRESHOLDS.map((t) => automation(rows, t, ['team', 'urgent'])),
      team: THRESHOLDS.map((t) => automation(rows, t, ['team'])),
      urgent: THRESHOLDS.map((t) => automation(rows, t, ['urgent'])),
      mixed: automation(rows, MIXED, ['team', 'urgent']),
    },
    reliabilityTeam: reliability(rows.map((r) => ({ stated: Math.max(...Object.values(r.team.probabilities)), correct: r.correct.team }))),
    reliabilityUrgent: reliability(
      rows.map((r) => ({ stated: Math.max(r.urgent.probability, 1 - r.urgent.probability), correct: r.correct.urgent })),
    ),
  };
}

const summaries = Object.entries(results).map(([name, { rows }]) => summarise(name, rows));
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const num = (x, d = 3) => x.toFixed(d);
const ms = (x) => (x < 1 ? '<1 ms' : `${Math.round(x)} ms`);
const usd = (x) => (x === 0 ? '$0' : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);

const md = [];
md.push('# Evaluation results');
md.push('');
md.push(
  `Generated by \`node eval/run.mjs\` on ${emails.length} invented, hand-labelled support emails for a fictional bookkeeping app ` +
    `(${LABELS.map((l) => `${emails.filter((e) => e.team === l).length} ${l}`).join(', ')}; ` +
    `${emails.filter((e) => e.urgent).length} urgent). Each backend answers the same two questions per email: ` +
    'a Choice of team and a Yes/No on urgency. Jev and the chat model were called live once; their answers are recorded in `eval/cache/` and replayed.',
);
md.push('');
md.push('## Automation at a confidence threshold');
md.push('');
md.push(
  'An email is handled automatically when **both** answers reach the threshold (Choice confidence for the team, distance from 0.5 for urgency, ' +
    'the same rule the n8n node uses). Everything else goes to a person. "Accuracy" is on the automated share only; "wrong" counts automated emails with a wrong team or urgency.',
);
md.push('');
md.push(`| Backend | ${THRESHOLDS.map((t) => `automated @ ${t}`).join(' | ')} | ${THRESHOLDS.map((t) => `accuracy @ ${t}`).join(' | ')} | ${THRESHOLDS.map((t) => `wrong @ ${t}`).join(' | ')} |`);
md.push(`|---|${THRESHOLDS.map(() => '---:').join('|')}|${THRESHOLDS.map(() => '---:').join('|')}|${THRESHOLDS.map(() => '---:').join('|')}|`);
for (const s of summaries) {
  const a = s.automation.both;
  md.push(`| ${NAMES[s.name]} | ${a.map((x) => pct(x.rate)).join(' | ')} | ${a.map((x) => (x.automated ? pct(x.accuracy) : '–')).join(' | ')} | ${a.map((x) => x.wrongLetThrough).join(' | ')} |`);
}
md.push('');
md.push('Per question:');
md.push('');
md.push(`| Backend | Question | ${THRESHOLDS.map((t) => `automated @ ${t}`).join(' | ')} | ${THRESHOLDS.map((t) => `accuracy @ ${t}`).join(' | ')} |`);
md.push(`|---|---|${THRESHOLDS.map(() => '---:').join('|')}|${THRESHOLDS.map(() => '---:').join('|')}|`);
for (const s of summaries) {
  for (const q of ['team', 'urgent']) {
    const a = s.automation[q];
    md.push(`| ${NAMES[s.name]} | ${q} | ${a.map((x) => pct(x.rate)).join(' | ')} | ${a.map((x) => (x.automated ? pct(x.accuracy) : '–')).join(' | ')} |`);
  }
}
md.push('');
md.push(
  `With a threshold per question (team ${MIXED.team}, urgency ${MIXED.urgent}, set with the node's "Own Threshold" field). ` +
    'This setting was picked after reading the per-question table, so treat it as an illustration of the feature rather than a held-out result.',
);
md.push('');
md.push('| Backend | Automated | Accuracy on automated | Wrong |');
md.push('|---|---:|---:|---:|');
for (const s of summaries) {
  const m = s.automation.mixed;
  md.push(`| ${NAMES[s.name]} | ${pct(m.rate)} | ${m.automated ? pct(m.accuracy) : '–'} | ${m.wrongLetThrough} |`);
}
md.push('');
md.push('## Accuracy, calibration, speed and cost');
md.push('');
md.push('| Backend | Team accuracy | Team macro-F1 | Team Brier | Urgent accuracy | Urgent F1 | Urgent Brier | Both right | Latency p50 | Latency p95 | Cost per 1,000 emails |');
md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const s of summaries) {
  md.push(
    `| ${NAMES[s.name]} | ${pct(s.teamAccuracy)} | ${num(s.teamMacroF1)} | ${num(s.teamBrier)} | ${pct(s.urgentAccuracy)} | ${num(s.urgentF1)} | ${num(s.urgentBrier)} | ${pct(s.bothCorrect)} | ${ms(s.p50)} | ${ms(s.p95)} | ${usd(s.costPer1000)} |`,
  );
}
md.push('');
md.push(
  'Brier score: the mean squared gap between the stated probabilities and what was true (lower is better; team uses the multi-class form, 0 to 2). ' +
    'Latency is one request per email (both questions together), measured from this machine when the answers were recorded. ' +
    `Cost uses the recorded token counts: Jev at $${JEV_PRICE.inputPerMillion} per million input tokens with free output; ` +
    `the chat model at list price, $${LLM_PRICE.inputPerMillion} input and $${LLM_PRICE.outputPerMillion} output per million tokens.`,
);
md.push('');
md.push('## Reliability');
md.push('');
md.push('Answers grouped by the probability each backend gave its own answer, against how often that answer was right. A well-calibrated backend has the two columns close together.');
for (const [title, key] of [['Team (Choice)', 'reliabilityTeam'], ['Urgent (Yes/No)', 'reliabilityUrgent']]) {
  md.push('');
  md.push(`**${title}**`);
  md.push('');
  md.push(`| Stated probability | ${summaries.map((s) => `${NAMES[s.name]}: n / stated / right`).join(' | ')} |`);
  md.push(`|---|${summaries.map(() => '---:').join('|')}|`);
  const bins = summaries[0]?.[key] ?? [];
  bins.forEach((bin, i) => {
    const label = `${bin.lo.toFixed(2)}–${bin.hi.toFixed(2)}`;
    const cells = summaries.map((s) => {
      const b = s[key][i];
      return b.n ? `${b.n} / ${pct(b.stated)} / ${pct(b.accuracy)}` : '0';
    });
    md.push(`| ${label} | ${cells.join(' | ')} |`);
  });
}
md.push('');
md.push('## Usage');
md.push('');
md.push('| Backend | Model reported | Requests | Input tokens | Output tokens |');
md.push('|---|---|---:|---:|---:|');
for (const s of summaries) md.push(`| ${NAMES[s.name]} | ${s.model} | ${s.n} | ${s.inputTokens.toLocaleString('en-US')} | ${s.outputTokens.toLocaleString('en-US')} |`);
for (const [name, why] of Object.entries(skipped)) md.push('', `${NAMES[name]} was not run: ${why}.`);
md.push('');

writeFileSync(here('./results.md'), md.join('\n'));
writeFileSync(
  here('./results.json'),
  `${JSON.stringify({ emails: emails.length, thresholds: THRESHOLDS, summaries }, null, 1)}\n`,
);
for (const s of summaries) {
  const a = s.automation.both.map((x) => `${x.threshold}: ${pct(x.rate)} auto @ ${pct(x.accuracy)}`).join(', ');
  console.log(`${s.name.padEnd(5)} team ${pct(s.teamAccuracy)} urgent ${pct(s.urgentAccuracy)} | ${a}`);
}
console.log('wrote eval/results.md');
if (offline && Object.keys(skipped).length) process.exitCode = 1;
