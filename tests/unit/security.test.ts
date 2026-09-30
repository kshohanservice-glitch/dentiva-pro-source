import { describe, expect, it } from 'vitest';
import {
  activationDigestForTests,
  activationSignature,
  MAX_ACTIVATION_ATTEMPTS,
  machineFingerprint,
  machineIdentity,
  verifyActivationCode,
} from '@core/security/activation';
import {
  ARGON2_PARAMETERS,
  constantTimeEquals,
  hashPassword,
  passwordStrength,
  validatePassword,
  verifyPassword,
} from '@core/security/password';

describe('activation', () => {
  it('accepts only the product code, whatever its spacing', () => {
    const code = '1516591935015165';
    expect(verifyActivationCode(code)).toBe(true);
    expect(verifyActivationCode(' 1516-5919-3501-5165 ')).toBe(true);
    expect(verifyActivationCode('1516 5919 3501 5166')).toBe(false);
    expect(verifyActivationCode('')).toBe(false);
    expect(verifyActivationCode('123')).toBe(false);
  });

  it('stores a digest rather than the code itself', () => {
    const digest = activationDigestForTests();
    expect(digest).toMatch(/^[0-9a-f]{128}$/);
    expect(digest).not.toContain('1516591935015165');
    expect(digest).not.toBe('1516591935015165');
  });

  it('binds the activation to the machine fingerprint', () => {
    const first = machineFingerprint(machineIdentity('MACHINE-ONE'));
    const second = machineFingerprint(machineIdentity('MACHINE-TWO'));
    expect(first).not.toBe(second);
    expect(first).toBe(machineFingerprint(machineIdentity('MACHINE-ONE')));

    const digest = activationDigestForTests();
    const at = '2026-09-30T00:00:00.000Z';
    expect(activationSignature(digest, first, at)).toBe(activationSignature(digest, first, at));
    expect(activationSignature(digest, first, at)).not.toBe(activationSignature(digest, second, at));
  });

  it('allows a bounded number of attempts', () => {
    expect(MAX_ACTIVATION_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(MAX_ACTIVATION_ATTEMPTS).toBeLessThanOrEqual(25);
  });
});

describe('passwords', () => {
  it('hashes with Argon2id and verifies without keeping the plaintext', async () => {
    const hash = await hashPassword('Clinic#2026');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).toContain(`m=${ARGON2_PARAMETERS.memorySize}`);
    expect(await verifyPassword('Clinic#2026', hash)).toBe(true);
    expect(await verifyPassword('Clinic#2027', hash)).toBe(false);
    expect(await verifyPassword('Clinic#2026', 'not-a-hash')).toBe(false);
  });

  it('enforces the password policy and reports every problem', () => {
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('alllowercase').ok).toBe(false);
    expect(validatePassword('12345678').ok).toBe(false);
    expect(validatePassword('dentiva123').ok).toBe(false);
    const strong = validatePassword('SmileClinic#26');
    expect(strong.ok).toBe(true);

    const problems = validatePassword('abc', { username: 'abcfront' });
    expect(problems.problems.length).toBeGreaterThan(1);
    // The product name must never be part of a password.
    expect(validatePassword('DentivaPro#26').ok).toBe(false);
  });

  it('scores password strength without ever being negative', () => {
    expect(passwordStrength('abc').score).toBeLessThan(2);
    expect(passwordStrength('SmileClinic#2026').score).toBeGreaterThanOrEqual(3);
  });

  it('compares secrets in constant time', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });
});
