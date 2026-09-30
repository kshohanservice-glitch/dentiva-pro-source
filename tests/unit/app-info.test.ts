/**
 * The product's own record of what it is.
 *
 * `src/shared/app-info.ts` is read by the About screen, the window title, the
 * installer metadata, the self-check report and the documentation. It must not
 * drift from `package.json` (which electron-builder stamps into the installer) or
 * from `electron-builder.yml` (which decides the application id and the artifact
 * names), because a mismatch is only visible to a user after installation.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_AUTHOR_EMAIL, APP_AUTHOR_NAME, APP_BUILD_NUMBER, APP_CURRENCY_SYMBOL, APP_ID, APP_NAME, APP_VERSION } from '@shared/app-info';

const root = process.cwd();

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8');
}

const manifest = JSON.parse(read('package.json')) as {
  name: string;
  version: string;
  productName: string;
  author: { name: string; email: string };
};

describe('product identity', () => {
  it('matches package.json', () => {
    expect(APP_VERSION).toBe(manifest.version);
    expect(APP_NAME).toBe(manifest.productName);
    expect(APP_AUTHOR_NAME).toBe(manifest.author.name);
    expect(APP_AUTHOR_EMAIL).toBe(manifest.author.email);
  });

  it('has a build number a person can read out over the phone', () => {
    expect(APP_BUILD_NUMBER).toMatch(/^\d+$/);
    expect(Number(APP_BUILD_NUMBER)).toBeGreaterThan(0);
  });

  it('uses the application id and the version placeholder the installer is built with', () => {
    const builder = read('electron-builder.yml');
    expect(builder).toContain(`appId: ${APP_ID}`);
    expect(builder).toContain('${version}');
  });

  it('formats money in taka, which is the currency every screen prints', () => {
    expect(APP_CURRENCY_SYMBOL).toBe('\u09F3');
  });
});
