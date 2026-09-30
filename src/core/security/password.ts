/**
 * Password hashing and policy.
 *
 * Argon2id (memory-hard) is used with parameters appropriate for a desktop
 * workstation: 64 MiB of memory, 3 passes, single lane. Hashes are stored in the
 * standard PHC encoded form, so the parameters travel with the hash and can be
 * raised later without invalidating existing credentials.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@shared/constants';

export const ARGON2_PARAMETERS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // KiB (64 MiB)
  hashLength: 32,
} as const;

export interface PasswordPolicy {
  readonly minLength: number;
  readonly requireLetter: boolean;
  readonly requireNumber: boolean;
  readonly forbidCommonPasswords: boolean;
  readonly forbidUsername: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: PASSWORD_MIN_LENGTH,
  requireLetter: true,
  requireNumber: true,
  forbidCommonPasswords: true,
  forbidUsername: true,
};

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'admin123', 'administrator', 'dentiva', 'dentivapro', 'dental123', 'clinic123', 'welcome1', 'letmein1',
  'iloveyou', 'abc12345', 'passw0rd', 'bangladesh', 'dhaka123', 'doctor123', 'patient1',
]);

export interface PasswordValidationResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export function validatePassword(
  password: string,
  options: { policy?: PasswordPolicy; username?: string; fullName?: string } = {},
): PasswordValidationResult {
  const policy = options.policy ?? DEFAULT_PASSWORD_POLICY;
  const problems: string[] = [];
  if (password.length < policy.minLength) {
    problems.push(`Use at least ${policy.minLength} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Passwords cannot be longer than ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (policy.requireLetter && !/[A-Za-z]/.test(password)) {
    problems.push('Include at least one letter.');
  }
  if (policy.requireNumber && !/[0-9]/.test(password)) {
    problems.push('Include at least one number.');
  }
  if (policy.forbidCommonPasswords && COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push('This password is too common. Choose something less predictable.');
  }
  const username = options.username?.trim().toLowerCase();
  if (policy.forbidUsername && username && username.length >= 4 && password.toLowerCase().includes(username)) {
    problems.push('The password must not contain the username.');
  }
  if (/\s/.test(password)) {
    problems.push('Avoid spaces in the password.');
  }
  if (/(dentiva|dentivapro)/i.test(password)) {
    problems.push('The password must not contain the application name.');
  }
  return { ok: problems.length === 0, problems };
}

export interface PasswordStrength {
  readonly score: 0 | 1 | 2 | 3 | 4;
  readonly label: 'Very weak' | 'Weak' | 'Fair' | 'Strong' | 'Very strong';
  readonly suggestions: readonly string[];
}

export function passwordStrength(password: string): PasswordStrength {
  const suggestions: string[] = [];
  let score = 0;
  if (password.length >= 8) score += 1;
  else suggestions.push('Use at least 8 characters');
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  else suggestions.push('Mix upper and lower case letters');
  if (/[0-9]/.test(password)) score += 1;
  else suggestions.push('Add a number');
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  else suggestions.push('Add a symbol for extra strength');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    score = 0;
    suggestions.push('Avoid common passwords');
  }
  const clamped = Math.max(0, Math.min(4, score - 1)) as 0 | 1 | 2 | 3 | 4;
  const labels: ReadonlyArray<PasswordStrength['label']> = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  return { score: clamped, label: labels[clamped] ?? 'Weak', suggestions };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: ARGON2_PARAMETERS.parallelism,
    iterations: ARGON2_PARAMETERS.iterations,
    memorySize: ARGON2_PARAMETERS.memorySize,
    hashLength: ARGON2_PARAMETERS.hashLength,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (!encodedHash || !encodedHash.startsWith('$argon2')) return false;
  try {
    return await argon2Verify({ password, hash: encodedHash });
  } catch {
    return false;
  }
}

/** Constant-time string comparison for activation codes and tokens. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Compare against itself to keep timing independent of the mismatch position.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
