// Jev through the real API, with the same request builder the n8n node uses.
import { createRequire } from 'node:module';
import { DiskCache, OfflineMiss } from './cache.mjs';

const require = createRequire(import.meta.url);
const core = require('../../dist/nodes/JevDecision/core.js');

export const PRICE = { inputPerMillion: 0.042, outputPerMillion: 0 };

export class JevBackend {
  name = 'jev';

  constructor({ cachePath, offline, model = 'jev-latest', baseUrl = core.DEFAULT_BASE_URL }) {
    this.cache = new DiskCache(cachePath);
    this.offline = offline;
    this.model = model;
    this.baseUrl = baseUrl;
    this.liveCalls = 0;
  }

  async decide(state, specs) {
    const body = core.buildRequest(state, specs, this.model);
    const key = DiskCache.key(body);
    let record = this.cache.get(key);
    if (!record) {
      if (this.offline) throw new OfflineMiss('jev: no recorded response for this request');
      const apiKey = process.env.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set');
      const started = performance.now();
      const res = await fetch(`${this.baseUrl}${core.ENDPOINT}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const latencyMs = Math.round(performance.now() - started);
      if (!res.ok) throw new Error(`jev: HTTP ${res.status} ${await res.text()}`);
      record = { response: await res.json(), latencyMs };
      this.liveCalls++;
      this.cache.set(key, record);
    }
    const { response, latencyMs } = record;
    const decisions = Object.fromEntries(specs.map((s) => [s.key, core.readAnswer(s, response.answers[s.key], 0)]));
    return {
      decisions,
      latencyMs,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      model: response.model,
    };
  }
}
