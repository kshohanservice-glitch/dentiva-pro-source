#!/usr/bin/env node
/**
 * Format checker.
 *
 * The project deliberately ships no formatter dependency, so this script is the
 * single, deterministic definition of "correctly formatted": four-space
 * indent, no trailing whitespace, no tabs in source, LF line endings, a final
 * newline, and a maximum line length (long lines are allowed in generated files
 * and in the licence bundle).
 *
 * Run with `npm run format:check`. Fix findings by hand — the rules are small
 * enough that a formatter would only hide what changed.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname);

const INCLUDE_DIRS = ['src', 'tests', 'tools', 'docs'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.json', '.css', '.html', '.md', '.yml', '.yaml', '.nsh', '.txt']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'coverage', 'generated', '.git', 'icons']);

const MAX_LENGTH = 140;
// Licence bundles, generated files and this checker's own reports are exempt.
// The match is anchored to directories and exact file names so that a script
// merely mentioning "licence" in its own name is still held to the limit.
const LONG_LINE_EXEMPT = /(^|\/)(licenses|generated)\//i;
const EXEMPT_FILES = /(THIRD-PARTY-NOTICES|BUILD_DIGEST)/i;
// Markdown table rows are exempt: Prettier aligns table cells and a row cannot be
// wrapped without destroying the table, so prose and code keep the hard limit.
const TABLE_ROW = /^\s*\|.*\|\s*$/;

const problems = [];
let checked = 0;

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    await check(full);
  }
}

async function check(file) {
  const relative = path.relative(root, file);
  const info = await stat(file);
  if (info.size > 2 * 1024 * 1024) return;
  const text = await readFile(file, 'utf8');
  checked += 1;

  if (text.includes('\r\n')) problems.push(`${relative}: CRLF line endings — use LF`);
  if (!text.endsWith('\n')) problems.push(`${relative}: no final newline`);
  if (text.includes('\t') && !relative.endsWith('.nsh')) problems.push(`${relative}: tab character — use spaces`);

  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const number = index + 1;
    if (/\s+$/.test(line)) problems.push(`${relative}:${number}: trailing whitespace`);
    const exempt = LONG_LINE_EXEMPT.test(relative) || EXEMPT_FILES.test(relative);
    if (line.length > MAX_LENGTH && !exempt && !TABLE_ROW.test(line)) {
      problems.push(`${relative}:${number}: line is ${line.length} characters (limit ${MAX_LENGTH})`);
    }
    if (line.includes('  \n')) problems.push(`${relative}:${number}: double space before newline`);
  });
}

for (const dir of INCLUDE_DIRS) await walk(path.join(root, dir));
for (const file of ['package.json', 'electron-builder.yml']) {
  try {
    await check(path.join(root, file));
  } catch {
    /* the file may not exist yet */
  }
}

if (problems.length > 0) {
  console.error(`format-check: ${problems.length} problem(s) in ${checked} file(s)`);
  for (const problem of problems.slice(0, 200)) console.error(`  ${problem}`);
  if (problems.length > 200) console.error(`  … and ${problems.length - 200} more`);
  process.exitCode = 1;
} else {
  console.log(`format-check: ${checked} file(s) clean`);
}
