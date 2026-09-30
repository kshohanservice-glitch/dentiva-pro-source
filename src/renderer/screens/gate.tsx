/**
 * Activation, sign-in and lock screens.
 *
 * Their only job is to collect credentials; every rule (attempt limits,
 * lockout, digest comparison, permission snapshot) is enforced in the core
 * process. The screen simply shows what the core reports back.
 */
import { useEffect, useRef, useState } from 'react';
import { Lock, ShieldCheck, UserRound } from 'lucide-react';
import { APP_AUTHOR_EMAIL, APP_NAME } from '@shared/app-info';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { Avatar, Button, Banner, Field, Input } from '@renderer/components/ui';

export function ActivationScreen(): JSX.Element {
  const { toast, refresh } = useApp();
  const { run, busy } = useAction();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const status = useApi('activation.status', undefined);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async () => {
    setError(null);
    const result = await run(() => bridge.invoke('activation.activate', { code }), {
      success: 'This device is activated.',
      failure: 'The activation code was not accepted.',
    });
    if (!result) return;
    toast('success', 'Activation complete', 'The setup wizard opens next.');
    await refresh();
  };

  return (
    <div className="gate">
      <div className="gate__panel" style={{ maxWidth: 520 }}>
        <div className="gate__body">
          <div className="row" style={{ gap: 12 }}>
            <span className="avatar" style={{ width: 44, height: 44 }}>
              <ShieldCheck size={22} />
            </span>
            <div>
              <h1 style={{ margin: 0, fontSize: 22 }}>{APP_NAME} activation</h1>
              <p className="muted" style={{ margin: 0 }}>
                One-time local activation for this computer.
              </p>
            </div>
          </div>

          <Banner tone="info" title="Offline by design.">
            Dentiva Pro never contacts the internet. The activation code is checked on this machine only, which
            means it protects against accidental copying between computers rather than against a determined
            attacker with full access to the device.
          </Banner>

          <Field
            label="Activation code"
            hint="Enter the 16-digit code supplied with your licence (spaces and dashes are ignored)."
            error={error ?? undefined}
            required
          >
            <Input
              ref={input}
              value={code}
              autoComplete="off"
              spellCheck={false}
              className="mono"
              placeholder="0000000000000000"
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && code.trim()) void submit();
              }}
            />
          </Field>

          {status.data?.lastError ? (
            <Banner tone="warning" title="Previous attempt">
              {status.data.lastError}
            </Banner>
          ) : null}

          <Button variant="primary" size="lg" block loading={busy} disabled={code.trim().length < 8} onClick={() => void submit()}>
            Activate this device
          </Button>

          <p className="small muted" style={{ margin: 0 }}>
            Lost your code? Contact {APP_AUTHOR_EMAIL} with your clinic name. Activation is local and does not require
            an internet connection.
          </p>
        </div>
      </div>
    </div>
  );
}

export function LoginScreen(): JSX.Element {
  const { signIn, clinic, bootstrap } = useApp();
  const { run, busy } = useAction();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const submit = async () => {
    setError(null);
    const user = await run(() => signIn(username.trim(), password), {
      failure: 'Sign-in failed.',
    });
    if (!user) setError('Check the username and password, then try again.');
  };

  return (
    <div className="gate">
      <div className="gate__panel" style={{ maxWidth: 440 }}>
        <div className="gate__body">
          <div className="center stack" style={{ alignItems: 'center' }}>
            <span className="sidebar__logo" style={{ width: 52, height: 52, fontSize: 22 }}>
              ৳
            </span>
            <div className="center">
              <h1 style={{ margin: 0, fontSize: 22 }}>{clinic?.name ?? APP_NAME}</h1>
              <p className="muted small" style={{ margin: 0 }}>
                {clinic?.address || 'Sign in to continue'}
              </p>
            </div>
          </div>

          <Field label="Username" required>
            <Input
              ref={firstField}
              value={username}
              autoComplete="username"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="Password" required error={error ?? undefined}>
            <Input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && username && password) void submit();
              }}
            />
          </Field>

          <Button variant="primary" size="lg" block loading={busy} disabled={!username || !password} onClick={() => void submit()}>
            <UserRound size={16} /> Sign in
          </Button>

          <div className="center">
            <Button variant="link" size="sm" onClick={() => setShowHelp((value) => !value)}>
              I cannot sign in
            </Button>
          </div>
          {showHelp ? (
            <Banner tone="info" title="Signing in">
              Passwords are reset by the clinic owner or an administrator from <strong>Users &amp; roles</strong>.
              After five failed attempts the account locks for a short cooldown. {APP_AUTHOR_EMAIL} can help if the
              owner account is unavailable.
            </Banner>
          ) : null}
          {bootstrap?.previousShutdownWasAbnormal ? (
            <Banner tone="warning" title="The app closed unexpectedly last time.">
              Your data was checked and is intact. A backup is recommended.
            </Banner>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function LockScreen(): JSX.Element {
  const { session, unlock, signOut, clinic } = useApp();
  const { run, busy } = useAction();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const submit = async () => {
    setError(null);
    const user = await run(() => unlock(password), { failure: 'The password was not accepted.' });
    if (!user) setError('Incorrect password.');
  };

  return (
    <div className="lock-screen">
      <div className="lock-screen__card">
        <div className="lock-screen__clock">
          {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </div>
        <div className="muted small">{now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>

        <div className="row" style={{ justifyContent: 'center', gap: 12, marginTop: 18 }}>
          <Avatar name={session?.fullName ?? 'User'} size={44} />
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 650 }}>{session?.fullName}</div>
            <div className="small muted">{session?.roleNames.join(', ')}</div>
          </div>
        </div>

        <div style={{ maxWidth: 320, margin: '18px auto 0' }}>
          <Field label="Password" error={error ?? undefined}>
            <Input
              type="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && password) void submit();
              }}
            />
          </Field>
          <Button variant="primary" block loading={busy} disabled={!password} onClick={() => void submit()}>
            <Lock size={15} /> Unlock
          </Button>
          <div className="center" style={{ marginTop: 10 }}>
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                void run(() => signOut());
              }}
            >
              Sign in as a different user
            </Button>
          </div>
        </div>

        <p className="small muted" style={{ marginTop: 18 }}>
          {clinic?.name ? `${clinic.name} · ` : ''}The session locked automatically to protect patient data.
        </p>
      </div>
    </div>
  );
}
