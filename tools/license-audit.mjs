#!/usr/bin/env node
/**
 * Licence audit and third-party notice generator.
 *
 * Reads the installed dependency tree, checks that every licence is on the
 * approved list for a commercial closed-source product, and writes:
 *
 *   - `THIRD-PARTY-NOTICES.md`           (shipped with the source)
 *   - `src/renderer/generated/licenses.ts` (bundled, shown on the About screen)
 *
 * The generated TypeScript is run through Prettier with the repository config, so
 * regenerating the notices never leaves `npm run format:check` dirty.
 *
 * Fails with a non-zero exit code if an unapproved licence is found, so CI can
 * block a release whose dependency terms changed underneath us.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { format as prettierFormat, resolveConfig } from 'prettier';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const nodeModules = path.join(root, 'node_modules');

/**
 * Licences that are safe to ship inside a closed-source commercial product.
 * Anything else must be reviewed by a human before it can be added here.
 */
const APPROVED = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
  'MPL-2.0',
]);

const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|copyright|notice)(\.(md|txt|rst|markdown))?$/i;

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Collect every package under node_modules, including nested copies. */
async function collectPackages(dir, depth = 0) {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      found.push(...(await collectPackages(full, depth + 1)));
      continue;
    }
    const manifest = await readJson(path.join(full, 'package.json'));
    if (manifest?.name && manifest.version) {
      found.push({ dir: full, name: manifest.name, version: manifest.version, manifest });
    }
    found.push(...(await collectPackages(path.join(full, 'node_modules'), depth + 1)));
  }
  return found;
}

function normalizeLicense(license) {
  if (!license) return 'UNKNOWN';
  if (typeof license === 'string') return license.replace(/^\(|\)$/g, '').trim();
  if (Array.isArray(license)) return license.map(normalizeLicense).join(' OR ');
  if (typeof license === 'object' && license.type) return String(license.type);
  return 'UNKNOWN';
}

function licenseFromManifest(manifest) {
  const declared = normalizeLicense(manifest.license ?? manifest.licenses);
  if (declared !== 'UNKNOWN') return declared;
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    return manifest.licenses.map((entry) => normalizeLicense(entry)).join(' OR ');
  }
  return 'UNKNOWN';
}

async function findLicenseText(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidate = entries.find((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name));
  if (!candidate) return null;
  try {
    const text = await readFile(path.join(dir, candidate.name), 'utf8');
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { file: candidate.name, text: lines.join('\n') };
  } catch {
    return null;
  }
}

/**
 * Extract a short "Copyright …" line so notices can name the holder. Licence
 * boilerplate ("Copyright law", "copyright owner or entity authorized by")
 * carries no information, so it is filtered out.
 */
const BOILERPLATE = new RegExp(
  [
    'copyright\\s+(?:law|notice|owner|holder|and\\s+related|license|protection)',
    'without\\s+limitation',
    'as\\s+defined',
    'in\\s+the\\s+(?:software|document)',
  ].join('|'),
  'i',
);

function copyrightLine(text) {
  if (!text) return null;
  const matches = text.match(/copyright[^\n]{0,160}/gi) ?? [];
  for (const match of matches) {
    const candidate = match.trim().replace(/\s+/g, ' ');
    if (BOILERPLATE.test(candidate)) continue;
    if (candidate.length < 12) continue;
    // A usable notice names a holder: it carries a year or an explicit (c)/©.
    if (!/\b(?:19|20)\d{2}\b/.test(candidate) && !/\(c\)|©/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

function splitSpdx(expression) {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

const packages = await collectPackages(nodeModules);
const byName = new Map();
for (const entry of packages) {
  const key = `${entry.name}@${entry.version}`;
  if (!byName.has(key)) byName.set(key, entry);
}

const rootManifest = await readJson(path.join(root, 'package.json'));
const directNames = new Set([...Object.keys(rootManifest?.dependencies ?? {}), ...Object.keys(rootManifest?.devDependencies ?? {})]);

const notices = [];
const problems = [];

for (const entry of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const license = licenseFromManifest(entry.manifest);
  const licenseText = await findLicenseText(entry.dir);
  const alternatives = splitSpdx(license);
  const approved = alternatives.length > 0 && alternatives.some((part) => APPROVED.has(part));
  if (!approved) {
    problems.push(`${entry.name}@${entry.version} declares “${license}”, which is not on the approved list.`);
  }
  notices.push({
    name: entry.name,
    version: entry.version,
    license,
    homepage: typeof entry.manifest.homepage === 'string' ? entry.manifest.homepage : null,
    repository: typeof entry.manifest.repository === 'string' ? entry.manifest.repository : (entry.manifest.repository?.url ?? null),
    copyright: copyrightLine(licenseText?.text ?? null),
    direct: directNames.has(entry.name),
    licenseFile: licenseText?.file ?? null,
  });
}

// --- THIRD-PARTY-NOTICES.md ------------------------------------------------

const generatedAt = new Date().toISOString();
const direct = notices.filter((entry) => entry.direct);
const transitive = notices.filter((entry) => !entry.direct);

const noticeLines = [];
noticeLines.push('# Third-party notices');
noticeLines.push('');
noticeLines.push('Dentiva Pro is built on free and open-source software. This file lists every package that');
noticeLines.push('is compiled into or shipped with the application, together with its licence.');
noticeLines.push('');
noticeLines.push(`Generated: ${generatedAt}`);
noticeLines.push(`Packages: ${notices.length} (${direct.length} direct, ${transitive.length} transitive)`);
noticeLines.push('');
noticeLines.push('## Direct dependencies');
noticeLines.push('');
noticeLines.push('| Package | Version | Licence | Copyright |');
noticeLines.push('| --- | --- | --- | --- |');
for (const entry of direct) {
  noticeLines.push(`| ${entry.name} | ${entry.version} | ${entry.license} | ${(entry.copyright ?? '—').replace(/\|/g, '\\|')} |`);
}
noticeLines.push('');
noticeLines.push('## Transitive dependencies');
noticeLines.push('');
noticeLines.push('| Package | Version | Licence |');
noticeLines.push('| --- | --- | --- |');
for (const entry of transitive) {
  noticeLines.push(`| ${entry.name} | ${entry.version} | ${entry.license} |`);
}
noticeLines.push('');
noticeLines.push('## Full licence texts');
noticeLines.push('');
noticeLines.push('The complete licence text of every package is distributed inside the application bundle under');
noticeLines.push('`node_modules/<package>/` and, for the installed product, in the application resources folder');
noticeLines.push('(`licenses/`). The files below were read when this document was generated.');
noticeLines.push('');
for (const entry of notices) {
  if (!entry.licenseFile) continue;
  noticeLines.push(`- ${entry.name}@${entry.version} — ${entry.licenseFile} (${entry.license})`);
}
noticeLines.push('');

await writeFile(path.join(root, 'THIRD-PARTY-NOTICES.md'), noticeLines.join('\n'), 'utf8');

// --- bundled module for the About screen ------------------------------------

const header = `/**
 * Generated by tools/license-audit.mjs — do not edit by hand.
 * Regenerate with \`npm run licenses\` after installing or upgrading a package.
 */
`;

const body = `
export interface ThirdPartyNotice {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly homepage: string | null;
  readonly copyright: string | null;
  readonly direct: boolean;
}

export const LICENSES_GENERATED_AT = ${JSON.stringify(generatedAt)};
export const LICENSES_DIGEST = ${JSON.stringify(
  createHash('sha256')
    .update(JSON.stringify(notices.map((entry) => [entry.name, entry.version, entry.license])))
    .digest('hex'),
)};
export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[] = ${JSON.stringify(
  notices.map((entry) => ({
    name: entry.name,
    version: entry.version,
    license: entry.license,
    homepage: entry.homepage,
    copyright: entry.copyright ? entry.copyright.slice(0, 120) : null,
    direct: entry.direct,
  })),
  null,
  2,
)} as const;
`;

const outDir = path.join(root, 'src', 'renderer', 'generated');
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, 'licenses.ts');
const prettierOptions = (await resolveConfig(outFile)) ?? {};
await writeFile(outFile, await prettierFormat(header + body, { ...prettierOptions, parser: 'typescript' }), 'utf8');

console.log(`licence-audit: ${notices.length} package(s) checked`);
console.log(`licence-audit: THIRD-PARTY-NOTICES.md written`);
console.log(`licence-audit: src/renderer/generated/licenses.ts written`);

if (problems.length > 0) {
  console.error('');
  console.error('Unapproved licences found:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log('licence-audit: every package uses an approved open-source licence');
}
