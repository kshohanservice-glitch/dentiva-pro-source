/**
 * Embedded typography.
 *
 * Dental documents are printed on machines that may not have a Bengali font at
 * all, and the application must never depend on the internet. The faces are
 * therefore read from the bundled `@fontsource` packages once at start-up and
 * inlined as `data:` URLs, which also makes the print window independent of any
 * file access policy.
 *
 * `Dentiva Sans` is a two-rule family: the Latin face covers Latin text and the
 * Bengali face is used for Bengali script through `unicode-range`, so a mixed
 * English/Bengali prescription renders with matching weights on both scripts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LATIN_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308,' +
  ' U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const BENGALI_RANGE = 'U+0964-0965, U+0980-09FF, U+200C-200D, U+20B9, U+25CC, U+A8E0-A8FF';

interface Face {
  readonly file: string;
  readonly family: string;
  readonly weight: number;
  readonly range: string;
}

const FACES: readonly Face[] = [
  { file: 'inter/files/inter-latin-400-normal.woff2', family: 'Inter', weight: 400, range: LATIN_RANGE },
  { file: 'inter/files/inter-latin-600-normal.woff2', family: 'Inter', weight: 600, range: LATIN_RANGE },
  { file: 'inter/files/inter-latin-700-normal.woff2', family: 'Inter', weight: 700, range: LATIN_RANGE },
  {
    file: 'noto-sans-bengali/files/noto-sans-bengali-bengali-400-normal.woff2',
    family: 'Noto Sans Bengali',
    weight: 400,
    range: BENGALI_RANGE,
  },
  {
    file: 'noto-sans-bengali/files/noto-sans-bengali-bengali-600-normal.woff2',
    family: 'Noto Sans Bengali',
    weight: 600,
    range: BENGALI_RANGE,
  },
  {
    file: 'noto-sans-bengali/files/noto-sans-bengali-bengali-700-normal.woff2',
    family: 'Noto Sans Bengali',
    weight: 700,
    range: BENGALI_RANGE,
  },
];

let cached: string | null = null;

function faceRule(appPath: string, face: Face, alias: string): string | null {
  const path = join(appPath, 'node_modules', '@fontsource', face.file);
  let encoded: string;
  try {
    encoded = readFileSync(path).toString('base64');
  } catch {
    return null;
  }
  return (
    `@font-face { font-family: '${alias}'; font-style: normal; font-weight: ${face.weight}; font-display:` +
    ` block; src: url(data:font/woff2;base64,${encoded}) format('woff2'); unicode-range: ${face.range}; }`
  );
}

/**
 * Font-face CSS for the print documents and the renderer, or an empty string
 * when the font packages are not present (a source checkout that skipped
 * `npm install`); callers must treat typography as best-effort only.
 */
export function loadEmbeddedFontCss(appPath: string): string {
  if (cached !== null) return cached;
  const rules: string[] = [];
  for (const face of FACES) {
    const own = faceRule(appPath, face, face.family);
    if (own) rules.push(own);
    const alias = faceRule(appPath, face, 'Dentiva Sans');
    if (alias) rules.push(alias);
  }
  cached = rules.join('\n');
  return cached;
}
