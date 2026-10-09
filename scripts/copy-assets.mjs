// Copies the node icon and codex file next to the compiled node, where n8n looks for them.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const dir of ['nodes/JevDecision', 'credentials']) {
  mkdirSync(join(root, 'dist', dir), { recursive: true });
  for (const file of readdirSync(join(root, dir))) {
    if (file.endsWith('.svg') || file.endsWith('.node.json')) {
      copyFileSync(join(root, dir, file), join(root, 'dist', dir, file));
    }
  }
}
