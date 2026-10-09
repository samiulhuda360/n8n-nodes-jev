// A deterministic keyword baseline with no model: what a team would write in an n8n IF or Switch node.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../dist/nodes/JevDecision/core.js');

export const KEYWORDS = {
  billing: ['charge', 'charged', 'refund', 'invoice', 'receipt', 'card', 'payment', 'billing', 'billed', 'subscription', 'vat', 'tax id', 'price', 'plan', 'renewal', 'overcharged', 'direct debit', 'cancel'],
  technical: ['error', 'bug', 'crash', 'broken', 'slow', 'sync', 'feed', 'import', 'export', 'report', 'api', 'webhook', 'integration', 'not working', 'blank', 'missing', 'duplicate', 'down', 'upload', 'payroll'],
  account: ['login', 'log in', 'logged', 'sign in', 'password', '2fa', 'two-factor', 'authenticator', 'mfa', 'sso', 'locked', 'access', 'admin', 'user', 'permission', 'role', 'owner', 'hacked'],
  sales: ['pricing', 'quote', 'demo', 'trial', 'discount', 'partner', 'reseller', 'buy', 'purchase', 'sign up', 'seats', 'enterprise', 'contract', 'nonprofit', 'program'],
};

export const URGENT_KEYWORDS = [
  'urgent', 'asap', 'immediately', 'right now', 'today', 'tonight', 'this morning', 'this afternoon', 'now',
  'hacked', 'stolen', 'down', 'cannot', "can't", 'locked out', 'deadline', 'tomorrow',
];

function escape(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hits(text, words) {
  return words.reduce((n, w) => n + (new RegExp(`\\b${escape(w)}\\b`, 'i').test(text) ? 1 : 0), 0);
}

export class RulesBackend {
  name = 'rules';
  liveCalls = 0;

  async decide(state, specs) {
    const started = performance.now();
    const decisions = {};
    for (const s of specs) {
      if (s.type === 'choice') {
        const names = Object.keys(s.options);
        const counts = names.map((n) => hits(state, KEYWORDS[n] ?? []));
        const total = counts.reduce((a, b) => a + b, 0);
        // No keyword at all: send it to the busiest team (technical), with zero confidence.
        const probabilities = Object.fromEntries(names.map((n, i) => [n, total ? counts[i] / total : 1 / names.length]));
        const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
        const answer = total ? ranked[0][0] : 'technical';
        decisions[s.key] = {
          key: s.key,
          type: 'choice',
          answer,
          probabilities,
          confidence: core.choiceConfidence(Object.values(probabilities)),
        };
      } else if (s.type === 'noul') {
        const n = hits(state, URGENT_KEYWORDS);
        const p = n >= 2 ? 0.97 : n === 1 ? 0.85 : 0.05;
        decisions[s.key] = { key: s.key, type: 'noul', answer: p >= 0.5, probability: p, confidence: core.noulConfidence(p) };
      }
    }
    return { decisions, latencyMs: performance.now() - started, inputTokens: 0, outputTokens: 0, model: 'keyword rules' };
  }
}
