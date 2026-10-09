// Starts the n8n editor with this node loaded from dist/, using the same throwaway data folder as n8n-run.mjs.
//
//   N8N_BIN=<path to n8n's bin/n8n> node scripts/n8n-start.mjs     then open http://localhost:5691
import { spawn } from 'node:child_process';
import { n8nCommand, n8nEnv, setup } from './n8n-run.mjs';

setup();
const [cmd, ...pre] = n8nCommand();
const child = spawn(cmd, [...pre, 'start'], {
  env: n8nEnv({ N8N_PORT: process.env.N8N_PORT || '5691', N8N_SECURE_COOKIE: 'false' }),
  stdio: 'inherit',
  shell: /\.(cmd|bat)$/i.test(cmd),
});
child.on('exit', (code) => process.exit(code ?? 0));
