// A general-purpose chat model through an OpenAI-compatible API, asked the same typed questions and told to
// return JSON with a stated probability. Default: Gemini Flash-Lite. The key comes from AI_API_KEY.
import { createRequire } from 'node:module';
import { DiskCache, OfflineMiss } from './cache.mjs';

const require = createRequire(import.meta.url);
const core = require('../../dist/nodes/JevDecision/core.js');

// List price per million tokens for Gemini Flash-Lite, used to turn recorded usage into a cost.
export const PRICE = { inputPerMillion: 0.1, outputPerMillion: 0.4 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The prompt: the same instructions, options and yes/no descriptions Jev receives. */
export function buildMessages(state, specs) {
  const lines = [];
  const shape = {};
  for (const s of specs) {
    if (s.type === 'choice') {
      lines.push(`"${s.key}" (pick exactly one option): ${s.instructions}`);
      for (const [name, description] of Object.entries(s.options)) lines.push(`  - ${name}: ${description ?? ''}`);
      shape[s.key] = { choice: '<option name>', probability: '<0..1, how likely this option is correct>' };
    } else if (s.type === 'noul') {
      lines.push(`"${s.key}" (yes/no): ${s.instructions}`);
      if (s.yes) lines.push(`  - yes means: ${s.yes}`);
      if (s.no) lines.push(`  - no means: ${s.no}`);
      shape[s.key] = { probability: '<0..1, the probability that the answer is yes>' };
    } else {
      lines.push(`"${s.key}" (score, pick a level number): ${s.instructions}`);
      s.levels.forEach((l, i) => lines.push(`  - ${i}: ${l}`));
      shape[s.key] = { level: '<level number>', probability: '<0..1, how likely this level is correct>' };
    }
  }
  return [
    {
      role: 'system',
      content:
        'You answer classification questions about a customer email. Reply with JSON only, no prose. ' +
        'Give calibrated probabilities: use values near 1 or 0 only when you are sure.',
    },
    {
      role: 'user',
      content: `Email:\n"""\n${state}\n"""\n\nQuestions:\n${lines.join('\n')}\n\nReply with JSON in this shape:\n${JSON.stringify(shape, null, 2)}`,
    },
  ];
}

function clampP(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

/** Turns the model's JSON into the same Decision shape the node produces. */
export function readLlmAnswers(json, specs) {
  const out = {};
  for (const s of specs) {
    const a = json?.[s.key] ?? {};
    if (s.type === 'noul') {
      const p = clampP(a.probability);
      out[s.key] = { key: s.key, type: 'noul', answer: p >= 0.5, probability: p, confidence: core.noulConfidence(p) };
    } else if (s.type === 'choice') {
      const names = Object.keys(s.options);
      const choice = names.includes(a.choice) ? a.choice : names[0];
      const p = names.includes(a.choice) ? clampP(a.probability) : 1 / names.length;
      const rest = names.length > 1 ? (1 - p) / (names.length - 1) : 0;
      const probabilities = Object.fromEntries(names.map((n) => [n, n === choice ? p : rest]));
      const values = Object.values(probabilities);
      const top = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0][0];
      out[s.key] = { key: s.key, type: 'choice', answer: top, probabilities, confidence: core.choiceConfidence(values) };
    } else {
      const level = Math.max(0, Math.min(s.levels.length - 1, Math.round(Number(a.level) || 0)));
      const p = clampP(a.probability);
      out[s.key] = { key: s.key, type: 'score', answer: level, level, confidence: p };
    }
  }
  return out;
}

export class LlmBackend {
  name = 'llm';

  constructor({ cachePath, offline }) {
    this.cache = new DiskCache(cachePath);
    this.offline = offline;
    this.baseUrl = (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '');
    this.model = process.env.AI_MODEL || 'gemini-flash-lite-latest';
    this.minInterval = Math.max(2.5, Number(process.env.AI_MIN_INTERVAL) || 2.5) * 1000;
    this.lastCall = 0;
    this.liveCalls = 0;
  }

  async decide(state, specs) {
    const messages = buildMessages(state, specs);
    const request = { model: this.model, temperature: 0, response_format: { type: 'json_object' }, messages };
    const key = DiskCache.key(request);
    let record = this.cache.get(key);
    if (!record) {
      if (this.offline) throw new OfflineMiss('llm: no recorded response for this request');
      const apiKey = process.env.AI_API_KEY;
      if (!apiKey) throw new OfflineMiss('llm: AI_API_KEY is not set');
      record = await this.#call(request, apiKey);
      this.cache.set(key, record);
    }
    let json = {};
    try {
      json = JSON.parse(record.content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      json = {};
    }
    return {
      decisions: readLlmAnswers(json, specs),
      latencyMs: record.latencyMs,
      inputTokens: record.usage?.prompt_tokens ?? 0,
      outputTokens: record.usage?.completion_tokens ?? 0,
      model: record.model ?? this.model,
    };
  }

  async #call(request, apiKey) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + this.minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      const started = performance.now();
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const latencyMs = Math.round(performance.now() - started);
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await sleep(10000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`llm: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const body = await res.json();
      this.liveCalls++;
      return {
        content: body.choices?.[0]?.message?.content ?? '',
        usage: body.usage ?? {},
        model: body.model ?? request.model,
        latencyMs,
      };
    }
  }
}
