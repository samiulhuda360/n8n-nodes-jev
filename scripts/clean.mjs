// Removes the previous build so stale files never reach n8n.
import { rmSync } from 'node:fs';
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
