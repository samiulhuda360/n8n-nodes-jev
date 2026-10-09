// Writes copies of the example workflows for an n8n that loads this node from a folder (N8N_CUSTOM_EXTENSIONS)
// rather than as an installed community package. n8n names folder-loaded nodes "CUSTOM.<name>".
//
//   node scripts/custom-examples.mjs [out-dir]     (default: workflows/custom)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'workflows');

export function toCustom(workflow) {
  const copy = structuredClone(workflow);
  for (const node of copy.nodes) {
    if (node.type === 'n8n-nodes-jev.jevDecision') node.type = 'CUSTOM.jevDecision';
  }
  return copy;
}

export function writeCustomExamples(outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith('.json'))) {
    const workflow = JSON.parse(readFileSync(join(src, file), 'utf8'));
    writeFileSync(join(outDir, file), `${JSON.stringify(toCustom(workflow), null, 2)}\n`);
    written.push({ file, id: workflow.id, name: workflow.name });
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const out = resolve(process.argv[2] ?? join(root, 'workflows', 'custom'));
  for (const w of writeCustomExamples(out)) console.log(`wrote ${join(out, w.file)}`);
}
