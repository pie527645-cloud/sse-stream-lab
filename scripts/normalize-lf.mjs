import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(rootDir, 'dist', 'cli.js');

if (fs.existsSync(cliPath)) {
  const raw = fs.readFileSync(cliPath, 'utf8');
  const normalized = raw.replaceAll('\r\n', '\n');
  const withShebang = normalized.startsWith('#!/usr/bin/env node\n')
    ? normalized
    : `#!/usr/bin/env node\n${normalized}`;
  fs.writeFileSync(cliPath, withShebang, 'utf8');
}
