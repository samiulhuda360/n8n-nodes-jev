// A JSON file of recorded responses, keyed by a hash of the request. Replays make the evaluation repeatable
// offline and in CI, where no live API is ever called.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class DiskCache {
  constructor(path) {
    this.path = path;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    this.used = new Set();
  }

  static key(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
  }

  get(key) {
    this.used.add(key);
    return this.data[key];
  }

  /** Drops recordings no request asked for, so the cache holds exactly the current dataset. */
  prune() {
    const before = Object.keys(this.data).length;
    this.data = Object.fromEntries(Object.entries(this.data).filter(([k]) => this.used.has(k)));
    if (Object.keys(this.data).length !== before) this.#write();
    return before - Object.keys(this.data).length;
  }

  set(key, value) {
    this.used.add(key);
    this.data[key] = value;
    this.#write();
  }

  #write() {
    mkdirSync(dirname(this.path), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(this.data).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.path, `${JSON.stringify(sorted, null, 1)}\n`);
  }
}

export class OfflineMiss extends Error {}
