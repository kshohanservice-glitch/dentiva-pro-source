/**
 * Password policy — pure rules shared by the core services and the interface.
 *
 * The authoritative check runs in the business layer before a hash is created;
 * the same functions are importable from the renderer so the user sees the
 * problems while typing instead of after submitting. Nothing here touches the
 * filesystem or cryptography, so it is safe in both processes.
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './constants';

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

export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
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
