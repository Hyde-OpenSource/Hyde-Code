// `pnpm install-cli`: puts the `hyde` command on your PATH (a symlink in ~/.local/bin).
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'hub', 'bin', 'hyde');
if (process.platform === 'win32') {
  console.log(`Windows: add a shortcut or alias that runs:\n  bash "${target}"`);
  process.exit(0);
}
const binDir = process.env.HYDE_BIN_DIR ?? join(homedir(), '.local', 'bin');
const link = join(binDir, 'hyde');
mkdirSync(binDir, { recursive: true });
if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) {
  const current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  if (current !== target) {
    if (!current) {
      console.error(`${link} exists and is not Hyde's link; leaving it alone.`);
      process.exit(1);
    }
    unlinkSync(link);
  }
}
if (!existsSync(link)) symlinkSync(target, link);
console.log(`✓ hyde → ${target}`);
if (!(process.env.PATH ?? '').split(delimiter).includes(binDir)) {
  console.log(`\n${binDir} is not on your PATH. Add this line to ~/.bashrc or ~/.zshrc:\n  export PATH="${binDir}:$PATH"`);
} else {
  console.log('Open a terminal in any project folder and run: hyde');
}
