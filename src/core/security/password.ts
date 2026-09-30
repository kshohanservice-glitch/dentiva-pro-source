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
import {
  COMMON_PASSWORDS,
  DEFAULT_PASSWORD_POLICY,
  passwordStrength,
  validatePassword,
} from '@shared/password-policy';
import type { PasswordPolicy, PasswordStrength, PasswordValidationResult } from '@shared/password-policy';

export const ARGON2_PARAMETERS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // KiB (64 MiB)
  hashLength: 32,
} as const;

export { COMMON_PASSWORDS, DEFAULT_PASSWORD_POLICY, passwordStrength, validatePassword };
export type { PasswordPolicy, PasswordStrength, PasswordValidationResult };


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
