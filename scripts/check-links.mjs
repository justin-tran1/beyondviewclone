// Verifies that every local href/src/url() and #anchor in the site's HTML resolves.
// Usage: npm run check
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', '.git']);

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

const cache = new Map();
const read = (file) => {
  if (!cache.has(file)) cache.set(file, readFile(file, 'utf8'));
  return cache.get(file);
};

const files = await htmlFiles(ROOT);
const problems = [];
let checked = 0;

for (const file of files) {
  const html = await read(file);
  const refs = [
    ...[...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...html.matchAll(/"three(?:\/addons\/)?":\s*"([^"]+)"/g)].map((m) => m[1]),
  ];
  for (const ref of refs) {
    if (/^(https?:|mailto:|tel:|data:)/.test(ref)) continue;
    checked++;
    const [path, hash] = ref.split('#');
    const clean = path.split('?')[0];
    let target = !path ? file : clean.startsWith('/') ? join(ROOT, clean) : resolve(dirname(file), clean);
    const where = `${relative(ROOT, file)} -> ${ref}`;
    // Import-map prefixes point at a directory rather than a page.
    if (path.endsWith('/addons/')) {
      if (!(await stat(target).catch(() => null))?.isDirectory()) problems.push(`missing directory: ${where}`);
      continue;
    }
    if (path.endsWith('/') || path === '.' || path === '..') target = join(target, 'index.html');
    if (!(await exists(target))) {
      problems.push(`missing file: ${where}`);
      continue;
    }
    if (hash && target.endsWith('.html') && !(await read(target)).includes(`id="${hash}"`)) {
      problems.push(`missing anchor: ${where}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} broken reference(s) across ${files.length} page(s).`);
  process.exit(1);
}
console.log(`OK: ${checked} local references across ${files.length} page(s) resolve.`);
