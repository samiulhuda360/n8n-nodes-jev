// Runs the example workflows in a real n8n, headless, with this node loaded from dist/.
//
//   N8N_BIN=<path to n8n's bin/n8n> TYPESAFE_API_KEY=... node scripts/n8n-run.mjs [slug ...]
//
// It uses a throwaway n8n data folder (.n8n-test/), imports a TypeSafe credential whose key is the expression
// {{ $env.TYPESAFE_API_KEY }} (so no key is ever written to disk), imports the workflows and executes each one
// through its manual trigger. It prints what reached each output and saves the runs to .n8n-test/runs/.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL } from './build-workflows.mjs';
import { writeCustomExamples } from './custom-examples.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const folder = join(root, '.n8n-test');
const only = process.argv.slice(2);

export function n8nCommand() {
  const bin = process.env.N8N_BIN;
  if (!bin) return ['n8n'];
  return /\.(cmd|exe|bat)$/i.test(bin) ? [bin] : [process.execPath, bin];
}

export function n8nEnv(extra = {}) {
  return {
    ...process.env,
    N8N_USER_FOLDER: folder,
    N8N_CUSTOM_EXTENSIONS: join(root, 'dist'),
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_BLOCK_ENV_ACCESS_IN_NODE: 'false',
    N8N_RUNNERS_ENABLED: 'false',
    DB_SQLITE_POOL_SIZE: '1',
    ...extra,
  };
}

function n8n(args) {
  const [cmd, ...pre] = n8nCommand();
  const res = spawnSync(cmd, [...pre, ...args], {
    env: n8nEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: /\.(cmd|bat)$/i.test(cmd),
  });
  if (res.status !== 0) throw new Error(`n8n ${args.join(' ')} failed:\n${res.stdout?.slice(-3000)}\n${res.stderr?.slice(-3000)}`);
  return res.stdout;
}

/** `n8n execute --rawOutput` prints log lines first, then the execution as JSON. */
function executionJson(stdout) {
  let start = stdout.indexOf('{\n  "data"');
  if (start < 0) start = stdout.indexOf('{');
  return JSON.parse(stdout.slice(start));
}

function outputs(run, nodeName) {
  const runs = run.data.resultData.runData[nodeName] ?? [];
  const main = runs[0]?.data?.main ?? [];
  return main.map((items) => (items ?? []).map((i) => i.json));
}

export function setup() {
  mkdirSync(join(folder, 'import'), { recursive: true });
  const credential = [
    {
      id: CREDENTIAL.id,
      name: CREDENTIAL.name,
      type: 'typeSafeApi',
      data: { apiKey: '={{ $env.TYPESAFE_API_KEY }}', baseUrl: 'https://api.typesafe.ai' },
    },
  ];
  writeFileSync(join(folder, 'import', 'credentials.json'), JSON.stringify(credential, null, 2));
  n8n(['import:credentials', `--input=${join(folder, 'import', 'credentials.json')}`]);
  const workflows = writeCustomExamples(join(folder, 'import', 'workflows'));
  n8n(['import:workflow', '--separate', `--input=${join(folder, 'import', 'workflows')}`]);
  return workflows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.TYPESAFE_API_KEY) throw new Error('Set TYPESAFE_API_KEY to run the workflows against Jev');
  const workflows = setup();
  mkdirSync(join(folder, 'runs'), { recursive: true });
  let failed = 0;
  for (const w of workflows) {
    const slug = w.file.replace(/\.json$/, '');
    if (only.length && !only.includes(slug)) continue;
    const run = executionJson(n8n(['execute', `--id=${w.id}`, '--rawOutput']));
    writeFileSync(join(folder, 'runs', `${slug}.json`), JSON.stringify(run, null, 1));
    const error = run.data.resultData.error;
    console.log(`\n${w.name}  (${run.status ?? (error ? 'error' : 'success')})`);
    if (error) {
      failed++;
      console.log(`  error: ${error.message}`);
      continue;
    }
    const [confident, review] = outputs(run, 'Jev Decision');
    for (const [label, items] of [['Confident', confident ?? []], ['Needs review', review ?? []]]) {
      console.log(`  ${label}: ${items.length}`);
      for (const item of items) {
        const answers = Object.entries(item.jev.answers)
          .map(([k, a]) => `${k}=${typeof a.answer === 'number' ? a.answer.toFixed(2) : a.answer} (${a.confidence.toFixed(2)})`)
          .join('  ');
        const title = item.subject ?? item.title ?? item.company ?? '';
        console.log(`    - ${String(title).slice(0, 38).padEnd(38)} ${answers}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}
