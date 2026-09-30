/**
 * Change password — also the forced screen a new user sees on first sign-in.
 */
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useAction, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { Banner, Button, Card, Field, Input } from '@renderer/components/ui';

export function ChangePasswordScreen({ forced = false }: { forced?: boolean }): JSX.Element {
  const { session, refresh, toast, signOut } = useApp();
  const { run, busy } = useAction();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mismatch, setMismatch] = useState<string | null>(null);

  const submit = async () => {
    if (newPassword !== confirmPassword) {
      setMismatch('The two new passwords do not match.');
      return;
    }
    setMismatch(null);
    const done = await run(
      async () => {
        await bridge.invoke('auth.changePassword', { currentPassword, newPassword });
        await refresh();
      },
      { success: 'Password updated.', failure: 'The password could not be changed.' },
    );
    if (done !== null) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('success', 'Password changed', 'Use the new password the next time you sign in.');
    }
  };

  const body = (
    <div className="stack" style={{ maxWidth: 520 }}>
      {forced ? (
        <Banner tone="warning" title="Choose your own password">
          Your account was created with a temporary password. Set a password only you know before continuing.
        </Banner>
      ) : null}
      <Card title="Change password" subtitle={session ? `Signed in as ${session.username}` : undefined}>
        <div className="stack">
          <Field label="Current password" required>
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field
            label="New password"
            required
            hint="At least 8 characters with a letter and a number. Do not reuse the clinic or product name."
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label="Repeat new password" required error={mismatch ?? undefined}>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
          <div className="row row--end">
            {forced ? (
              <Button variant="ghost" onClick={() => void signOut()}>
                Sign out instead
              </Button>
            ) : null}
            <Button
              variant="primary"
              loading={busy}
              disabled={!currentPassword || !newPassword || !confirmPassword}
              onClick={() => void submit()}
            >
              <ShieldCheck size={16} /> Update password
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );

  if (forced) {
    return (
      <div className="gate">
        <div className="gate__panel" style={{ maxWidth: 620 }}>
          <div className="gate__body">{body}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__heading">Change password</h1>
          <p className="page__description">Passwords are hashed with Argon2id and never stored in readable form.</p>
        </div>
      </header>
      {body}
    </div>
  );
}
