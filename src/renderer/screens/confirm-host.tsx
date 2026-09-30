/**
 * Renders the confirmation dialog requested through `confirm()`.
 *
 * Destructive operations in Dentiva Pro always ask twice: once here and once in
 * the core service, which is why several of them also demand a typed word.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApp } from '@renderer/state/store';
import { Button, Field, Input, Modal, TextArea } from '@renderer/components/ui';

export function ConfirmHost(): JSX.Element | null {
  const { confirmState, resolveConfirm } = useApp();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    setTyped('');
    setReason('');
  }, [confirmState]);

  if (!confirmState) return null;
  const { title, description, confirmLabel, tone, typedWord, reason: wantsReason } = confirmState;
  const typedOk = !typedWord || typed.trim() === typedWord;
  const reasonOk = !wantsReason || reason.trim().length >= 3;

  return (
    <Modal
      open
      width="narrow"
      title={title}
      description={description}
      onClose={() => resolveConfirm({ ok: false })}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={() => resolveConfirm({ ok: false })}>
            Cancel
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={!typedOk || !reasonOk}
            onClick={() => resolveConfirm({ ok: true, typed: typed.trim(), reason: reason.trim() })}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="stack">
        {tone === 'danger' ? (
          <div className="banner banner--danger">
            <AlertTriangle size={18} />
            <div className="grow">This cannot be undone from the interface. A backup is created first when the operation supports it.</div>
          </div>
        ) : null}
        {wantsReason ? (
          <Field label="Reason" hint="Recorded in the audit log (at least 3 characters)." required>
            <TextArea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} />
          </Field>
        ) : null}
        {typedWord ? (
          <Field label={`Type “${typedWord}” to confirm`} required>
            <Input value={typed} className="mono" autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}
