/**
 * Offline activation.
 *
 * The product code is **never** present in the source or the build output. Only
 * a PBKDF2-SHA512 digest (310,000 iterations, per-product salt and pepper) is
 * compiled in, and the comparison is constant-time. The activation record is
 * bound to the machine fingerprint and signed with an HMAC key derived from the
 * digest, so copying the data folder to another computer does not transfer the
 * activation.
 *
 * Honest limitation (documented for the clinic): because activation is entirely
 * local, anyone with the binary and enough determination can analyse it. The
 * goal is to prevent casual copying, not to claim mathematical secrecy.
 */
import { createHmac, pbkdf2Sync, timingSafeEqual, randomBytes } from 'node:crypto';
import { arch, cpus, hostname, platform, release, userInfo } from 'node:os';
import type { SqliteDatabase } from '../db/connection';
import type { ActivationStatus } from '@shared/types';
import { nowInstant } from '@shared/dates';

/** Salt for the product-code digest (not secret by itself). */
const ACTIVATION_SALT_HEX = 'afb279d1c8dd14c53e25704cf148283f';
/** Application pepper mixed into the key derivation. */
const ACTIVATION_PEPPER = 'dentiva-pro::offline-activation::v1::bangladesh';
const ACTIVATION_ITERATIONS = 310_000;
/** PBKDF2-SHA512 digest of the product code — the only stored representation. */
const ACTIVATION_DIGEST_HEX =
  'a8ca4625bb15c04c1a453d8e0c5a020232f52fd0f9dd79720011d092b12ecdd592e94d46863227ed89a1ffbf7b1b026649515e7d11b61c0bea921f0d11082b13';

export const MAX_ACTIVATION_ATTEMPTS = 10;

function normaliseCode(input: string): string {
  return input.replace(/[\s\-_]/g, '').trim();
}

export function deriveCodeDigest(code: string): string {
  return pbkdf2Sync(
    `${normaliseCode(code)}${ACTIVATION_PEPPER}`,
    Buffer.from(ACTIVATION_SALT_HEX, 'hex'),
    ACTIVATION_ITERATIONS,
    64,
    'sha512',
  ).toString('hex');
}

/** Constant-time verification of a candidate activation code. */
export function verifyActivationCode(input: string): boolean {
  if (typeof input !== 'string') return false;
  const normalised = normaliseCode(input);
  if (normalised.length < 8 || normalised.length > 64) return false;
  const candidate = deriveCodeDigest(normalised);
  const expected = ACTIVATION_DIGEST_HEX;
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'));
}

// ---------------------------------------------------------------------------
// Machine binding
// ---------------------------------------------------------------------------

export interface MachineIdentity {
  readonly hostname: string;
  readonly platform: string;
  readonly arch: string;
  readonly username: string;
  readonly cpuModel: string;
  readonly osRelease: string;
  /** Windows MachineGuid when available, otherwise an empty string. */
  readonly machineGuid: string;
}

export function machineIdentity(machineGuid = ''): MachineIdentity {
  let username = '';
  try {
    username = userInfo().username;
  } catch {
    username = 'unknown';
  }
  const cpuList = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    username,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    osRelease: release(),
    machineGuid,
  };
}

export function machineFingerprint(identity: MachineIdentity = machineIdentity()): string {
  const material = [identity.machineGuid || identity.hostname, identity.platform, identity.arch, identity.username, identity.cpuModel].join(
    '|',
  );
  return createHmac('sha256', 'dentiva-pro/machine-binding/v1').update(material).digest('hex');
}

function signingKey(): Buffer {
  return pbkdf2Sync(`sign:${ACTIVATION_PEPPER}`, Buffer.from(ACTIVATION_DIGEST_HEX, 'hex').subarray(0, 16), 50_000, 32, 'sha512');
}

export function activationSignature(codeDigest: string, machineHash: string, activatedAt: string): string {
  return createHmac('sha256', signingKey()).update(`${codeDigest}|${machineHash}|${activatedAt}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface ActivationRow {
  activated_at: string;
  code_hash: string;
  machine_hash: string;
  signature: string;
  attempts: number;
  last_error: string | null;
}

export interface ActivationSaveResult {
  readonly activated: boolean;
  readonly status: ActivationStatus;
}

export function readActivation(db: SqliteDatabase): ActivationRow | null {
  const row = db
    .prepare(`SELECT activated_at, code_hash, machine_hash, signature, attempts, last_error FROM activation WHERE id = 1`)
    .get() as ActivationRow | undefined;
  return row ?? null;
}

function currentMachineHash(machineGuid: string | undefined): string {
  return machineFingerprint(machineIdentity(machineGuid ?? ''));
}

export function getActivationStatus(db: SqliteDatabase, machineGuid?: string): ActivationStatus {
  const row = readActivation(db);
  if (!row) {
    return { activated: false, activatedAt: null, machineBound: false, lastError: null };
  }
  const expectedSignature = activationSignature(row.code_hash, row.machine_hash, row.activated_at);
  const signatureValid = safeEqualHex(expectedSignature, row.signature);
  const machineMatches = row.machine_hash === currentMachineHash(machineGuid);
  const digestValid = safeEqualHex(row.code_hash, ACTIVATION_DIGEST_HEX);
  const activated = signatureValid && digestValid;
  let lastError = row.last_error;
  if (!activated && !lastError) lastError = 'The activation record is not valid for this installation.';
  else if (activated && !machineMatches && !lastError) {
    lastError = 'The activation belongs to a different computer. Re-enter the product code on this machine.';
  }
  return {
    activated,
    activatedAt: activated ? row.activated_at : null,
    machineBound: machineMatches,
    lastError,
  };
}

export function recordActivationAttempt(db: SqliteDatabase, errorMessage: string | null): void {
  const existing = readActivation(db);
  if (existing) {
    db.prepare(`UPDATE activation SET attempts = attempts + 1, last_error = ? WHERE id = 1`).run(errorMessage);
  } else {
    db.prepare(
      `INSERT INTO activation (id, activated_at, code_hash, machine_hash, signature, attempts, last_error)
       VALUES (1, ?, '', '', '', 1, ?)`,
    ).run(nowInstant(), errorMessage);
  }
}

export function activateWithCode(db: SqliteDatabase, code: string, machineGuid?: string): ActivationSaveResult {
  if (!verifyActivationCode(code)) {
    recordActivationAttempt(db, 'The activation code is not valid.');
    return { activated: false, status: getActivationStatus(db, machineGuid) };
  }
  const activatedAt = nowInstant();
  const machineHash = currentMachineHash(machineGuid);
  const codeDigest = deriveCodeDigest(code);
  const signature = activationSignature(codeDigest, machineHash, activatedAt);
  db.prepare(
    `INSERT INTO activation (id, activated_at, code_hash, machine_hash, signature, attempts, last_error)
     VALUES (1, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT (id) DO UPDATE SET
       activated_at = excluded.activated_at,
       code_hash = excluded.code_hash,
       machine_hash = excluded.machine_hash,
       signature = excluded.signature,
       attempts = 0,
       last_error = NULL`,
  ).run(activatedAt, codeDigest, machineHash, signature);
  return { activated: true, status: getActivationStatus(db, machineGuid) };
}

export function clearActivation(db: SqliteDatabase): void {
  db.prepare(`DELETE FROM activation`).run();
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Used by tests to prove the stored representation is not the plaintext code. */
export function activationDigestForTests(): string {
  return ACTIVATION_DIGEST_HEX;
}

export function randomSessionToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
