import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function setup() {
  execSync('npm run build', {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}
