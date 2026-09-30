/**
 * Users and roles.
 *
 * Permissions are enforced in the business layer, so this screen can only grant
 * or withhold what the core already understands: every checkbox maps to a real
 * permission key, grouped exactly as the core groups it.
 */
import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, ShieldCheck, UserCog, UserX } from 'lucide-react';
import type { Role, RoleInput, UserAccount, UserInput } from '@shared/types';
import { validatePassword } from '@shared/password-policy';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge } from '@renderer/lib/bridge';
import { fmtInstant } from '@renderer/lib/format';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Empty,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Page,
  SearchInput,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, PagedFooter, TextField, useListState } from '@renderer/components/forms';

const EMPTY_USER: UserInput = {
  username: '',
  fullName: '',
  email: '',
  phone: '',
  isActive: true,
  mustChangePassword: true,
  roleIds: [],
  password: '',
};

function UserDialog({
  open,
  user,
  roles,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: UserAccount | null;
  roles: readonly Role[];
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { runOk, busy } = useAction();
  const [form, setForm] = useState<UserInput>(EMPTY_USER);
  const [confirm, setConfirm] = useState('');
  const patch = (value: Partial<UserInput>) => setForm((current) => ({ ...current, ...value }));

  useEffect(() => {
    if (user) {
      setForm({
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        isActive: user.isActive,
        mustChangePassword: user.mustChangePassword,
        roleIds: [...user.roleIds],
      });
    } else {
      setForm({ ...EMPTY_USER });
    }
    setConfirm('');
  }, [user]);

  const problems = useMemo(() => {
    if (user || form.password === '') return [] as string[];
    const policy = validatePassword(form.password ?? '', { username: form.username, fullName: form.fullName });
    return policy.ok ? [] : [...policy.problems];
  }, [form.password, form.username, form.fullName, user]);

  if (!open) return null;

  const ready =
    form.fullName.trim().length >= 2 &&
    /^[a-z0-9._-]{3,24}$/.test(form.username.trim().toLowerCase()) &&
    form.roleIds.length > 0 &&
    (Boolean(user) || (form.password !== '' && problems.length === 0 && confirm === form.password));

  return (
    <Modal
      open
      width="wide"
      title={user ? `Edit ${user.fullName}` : 'New user'}
      description="Roles decide what a user can do; the core refuses anything the role does not allow."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              const input: UserInput = { ...form };
              if (user) delete input.password;
              const saved = await runOk(
                () =>
                  user
                    ? bridge.invoke('users.update', { id: user.id, input })
                    : bridge.invoke('users.create', { input: { ...input, password: form.password ?? '' } }),
                { success: user ? 'User updated.' : 'User created.', failure: 'The user could not be saved.' },
              );
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Save user
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <TextField
            label="Username"
            required
            hint="Lower case; 3–24 letters, numbers, dots, hyphens or underscores"
            value={form.username}
            onChange={(value) => patch({ username: value })}
          />
          <TextField label="Full name" required value={form.fullName} onChange={(value) => patch({ fullName: value })} />
        </div>
        <div className="grid-2">
          <TextField label="Email" value={form.email} onChange={(value) => patch({ email: value })} />
          <TextField label="Phone" value={form.phone} onChange={(value) => patch({ phone: value })} />
        </div>
        <div className="row" style={{ gap: 20 }}>
          <Switch label="Active" checked={form.isActive} onChange={(value) => patch({ isActive: value })} />
          <Switch
            label="Must change password at next sign-in"
            checked={form.mustChangePassword}
            onChange={(value) => patch({ mustChangePassword: value })}
          />
        </div>

        {!user ? (
          <div className="grid-2">
            <Field label="Initial password" required hint="At least 8 characters with a letter and a number">
              <Input type="password" value={form.password ?? ''} onChange={(event) => patch({ password: event.target.value })} />
            </Field>
            <Field
              label="Repeat password"
              required
              error={confirm !== '' && confirm !== form.password ? 'The passwords do not match.' : undefined}
            >
              <Input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </Field>
          </div>
        ) : null}

        {problems.length > 0 ? (
          <Banner tone="warning" title="The password needs work">
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        <Field label="Roles" required hint="A user may hold several roles; permissions are combined">
          <div className="stack stack--sm">
            {roles.map((role) => (
              <Checkbox
                key={role.id}
                label={`${role.name} — ${role.description}`}
                checked={form.roleIds.includes(role.id)}
                onChange={(checked) =>
                  patch({
                    roleIds: checked ? [...form.roleIds, role.id] : form.roleIds.filter((id) => id !== role.id),
                  })
                }
              />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function ResetPasswordDialog({ open, user, onClose }: { open: boolean; user: UserAccount | null; onClose(): void }): JSX.Element | null {
  const { run, busy } = useAction();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mustChange, setMustChange] = useState(true);

  useEffect(() => {
    setPassword('');
    setConfirm('');
    setMustChange(true);
  }, [user]);

  if (!open || !user) return null;

  const problems = password === '' ? [] : validatePassword(password, { username: user.username, fullName: user.fullName }).problems;
  const ready = password !== '' && problems.length === 0 && password === confirm;

  return (
    <Modal
      open
      width="narrow"
      title={`Reset the password for ${user.username}`}
      description="The old password stops working immediately. Nothing else about the account changes."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              const done = await run(() => bridge.invoke('users.resetPassword', { id: user.id, newPassword: password, mustChange }), {
                success: 'Password reset.',
              });
              if (done !== undefined) onClose();
            }}
          >
            Reset password
          </Button>
        </div>
      }
    >
      <div className="stack">
        <Field label="New password" required>
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Field label="Repeat password" required error={confirm !== '' && confirm !== password ? 'The passwords do not match.' : undefined}>
          <Input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </Field>
        {problems.length > 0 ? (
          <Banner tone="warning" title="The password needs work">
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        <Switch label="Require a change at next sign-in" checked={mustChange} onChange={setMustChange} />
      </div>
    </Modal>
  );
}

function RoleDialog({
  open,
  role,
  catalogue,
  onClose,
  onSaved,
}: {
  open: boolean;
  role: Role | null;
  catalogue: Array<{ key: string; group: string; label: string; description: string; sensitive: boolean; groupLabel: string }>;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { run, busy } = useAction();
  const [form, setForm] = useState<RoleInput>({ name: '', description: '', permissions: [] });
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (role) {
      setForm({ name: role.name, description: role.description, permissions: [...role.permissions] });
    } else {
      setForm({ name: '', description: '', permissions: [] });
    }
  }, [role]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; entries: typeof catalogue }>();
    for (const entry of catalogue) {
      if (filter && !`${entry.label} ${entry.key} ${entry.description}`.toLowerCase().includes(filter.toLowerCase())) continue;
      const group = map.get(entry.group) ?? { label: entry.groupLabel, entries: [] };
      group.entries.push(entry);
      map.set(entry.group, group);
    }
    return [...map.entries()];
  }, [catalogue, filter]);

  if (!open) return null;

  const toggle = (key: string, checked: boolean) =>
    setForm((current) => ({
      ...current,
      permissions: checked ? [...current.permissions, key] : current.permissions.filter((entry) => entry !== key),
    }));

  return (
    <Modal
      open
      width="wide"
      title={role ? `Edit ${role.name}` : 'New role'}
      description={role?.isSystem ? 'This is a built-in role; its key and system status cannot be removed.' : undefined}
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={form.name.trim().length < 2 || form.permissions.length === 0}
            onClick={async () => {
              const saved = await run(() => bridge.invoke('roles.save', { id: role?.id ?? null, input: form }), {
                success: role ? 'Role updated.' : 'Role created.',
                failure: 'The role could not be saved.',
              });
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Save role
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <TextField label="Role name" required value={form.name} onChange={(value) => setForm({ ...form, name: value })} />
          <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
            <span className="small muted">{form.permissions.length} permission(s) granted</span>
            <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, permissions: catalogue.map((entry) => entry.key) })}>
              Grant all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, permissions: [] })}>
              Clear
            </Button>
          </div>
        </div>
        <Field label="Description">
          <TextArea rows={2} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
        <Field label="Filter permissions">
          <SearchInput value={filter} placeholder="Type to narrow the list…" onChange={setFilter} />
        </Field>
        <div className="stack">
          {groups.map(([groupKey, group]) => (
            <Card
              key={groupKey}
              title={group.label}
              actions={
                <div className="row" style={{ gap: 6 }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        permissions: [...new Set([...current.permissions, ...group.entries.map((entry) => entry.key)])],
                      }))
                    }
                  >
                    Grant group
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        permissions: current.permissions.filter((key) => !group.entries.some((entry) => entry.key === key)),
                      }))
                    }
                  >
                    Clear group
                  </Button>
                </div>
              }
            >
              <div className="stack stack--sm">
                {group.entries.map((entry) => (
                  <div key={entry.key}>
                    <Checkbox
                      label={entry.label}
                      checked={form.permissions.includes(entry.key)}
                      onChange={(checked) => toggle(entry.key, checked)}
                    />
                    <div className="small muted" style={{ marginLeft: 26 }}>
                      {entry.description}
                      {entry.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function UsersScreen(): JSX.Element {
  const { confirm, session } = useApp();
  const { run } = useAction();
  const lists = useListState();
  const [tab, setTab] = useState('users');
  const [activeOnly, setActiveOnly] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [resetTarget, setResetTarget] = useState<UserAccount | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);

  const users = useApi(
    'users.list',
    tab === 'users' ? { ...lists.state, search: lists.state.search || undefined, isActive: activeOnly || undefined } : null,
    [tab, lists.state.page, lists.state.search, activeOnly],
  );
  const roles = useApi('roles.list', undefined);
  const catalogue = useApi('roles.permissionCatalogue', undefined);

  const userRows = users.data?.items ?? [];
  const roleRows = roles.data ?? [];

  const removeUser = async (user: UserAccount) => {
    const answer = await confirm({
      title: `Delete ${user.username}`,
      description: 'Users with recorded activity are deactivated instead of deleted, so their name stays attached to history.',
      confirmLabel: 'Delete user',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    await run(() => bridge.invoke('users.delete', { id: user.id, reason: answer.reason!, confirmText: user.username }), {
      success: 'User deleted or deactivated.',
    });
    users.reload();
  };

  const toggleActive = async (user: UserAccount) => {
    if (user.id === session?.id) return;
    await run(() => bridge.invoke('users.setActive', { id: user.id, isActive: !user.isActive }), {
      success: user.isActive ? 'User deactivated.' : 'User reactivated.',
    });
    users.reload();
  };

  const removeRole = async (role: Role) => {
    const answer = await confirm({
      title: `Delete the role “${role.name}”`,
      description:
        role.userCount > 0
          ? `${role.userCount} user(s) hold this role. Remove them from it before deleting.`
          : 'The role is removed from the permission list.',
      confirmLabel: 'Delete role',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    const done = await run(() => bridge.invoke('roles.delete', { id: role.id, reason: answer.reason!, confirmText: role.name }), {
      success: 'Role deleted.',
    });
    if (done !== null) roles.reload();
  };

  return (
    <Page
      title="Users & roles"
      description="Accounts that sign in, and the permissions each of them carries"
      actions={
        tab === 'users' ? (
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setEditingUser(null);
              setUserOpen(true);
            }}
          >
            New user
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setEditingRole(null);
              setRoleOpen(true);
            }}
          >
            New role
          </Button>
        )
      }
    >
      <div className="stat-grid">
        <Stat label="Accounts" value={String(userRows.length ? (users.data?.total ?? 0) : 0)} icon={<UserCog size={16} />} />
        <Stat label="Active" value={String(userRows.filter((user) => user.isActive).length)} tone="success" />
        <Stat label="Roles" value={String(roleRows.length)} icon={<ShieldCheck size={16} />} />
        <Stat label="Must change password" value={String(userRows.filter((user) => user.mustChangePassword).length)} tone="warning" />
      </div>

      <Tabs
        tabs={[
          { key: 'users', label: 'Users' },
          { key: 'roles', label: 'Roles & permissions' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'users' ? (
        <Card padded={false}>
          <div className="row row--wrap" style={{ padding: 'var(--space-4)', gap: 10 }}>
            <div style={{ minWidth: 240, flex: 1 }}>
              <SearchInput
                value={lists.state.search}
                placeholder="Search username or name…"
                onChange={(value) => lists.patch({ search: value })}
              />
            </div>
            <Switch label="Active only" checked={activeOnly} onChange={setActiveOnly} />
          </div>
          <DataTable
            columns={[
              { key: 'username', label: 'Username' },
              { key: 'name', label: 'Name' },
              { key: 'roles', label: 'Roles' },
              { key: 'lastLogin', label: 'Last sign-in' },
              { key: 'state', label: 'State' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={userRows.map((user) => ({
              username: (
                <div>
                  <span className="mono">{user.username}</span>
                  {user.id === session?.id ? <Badge tone="accent">You</Badge> : null}
                </div>
              ),
              name: (
                <div>
                  <div>{user.fullName}</div>
                  <div className="small muted">{user.email || user.phone || '—'}</div>
                </div>
              ),
              roles: (
                <div className="row row--wrap" style={{ gap: 6 }}>
                  {user.roleNames.length === 0 ? (
                    <span className="small muted">No role</span>
                  ) : (
                    user.roleNames.map((name) => <Badge key={name}>{name}</Badge>)
                  )}
                </div>
              ),
              lastLogin: user.lastLoginAt ? fmtInstant(user.lastLoginAt) : 'Never',
              state: (
                <div className="row" style={{ gap: 6 }}>
                  {user.lockedUntil ? <StatusBadge status="locked" label="Locked" /> : null}
                  <StatusBadge status={user.isActive ? 'active' : 'inactive'} label={user.isActive ? 'Active' : 'Inactive'} />
                  {user.mustChangePassword ? <Badge tone="warning">Change password</Badge> : null}
                </div>
              ),
              actions: (
                <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingUser(user);
                      setUserOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon={<KeyRound size={13} />} onClick={() => setResetTarget(user)}>
                    Password
                  </Button>
                  <Button size="sm" variant="ghost" disabled={user.id === session?.id} onClick={() => void toggleActive(user)}>
                    {user.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={user.id === session?.id} onClick={() => void removeUser(user)}>
                    Delete
                  </Button>
                </div>
              ),
            }))}
            loading={users.loading && !users.data}
            error={users.error}
            onRetry={users.reload}
            rowKey={(index) => String(userRows[index]?.id ?? index)}
            empty={<Empty title="No users" text="Create an account for each person who signs in." icon={<UserX size={24} />} />}
          />
          <PagedFooter page={lists.state.page} onPage={(page) => lists.patch({ page })} data={users.data} />
        </Card>
      ) : null}

      {tab === 'roles' ? (
        roles.loading && !roles.data ? (
          <LoadingBlock rows={4} />
        ) : (
          <div className="stack">
            <Banner tone="info" title="Permissions are enforced twice">
              The interface hides what a role cannot use, and the core refuses the call as well — so a permission can never be bypassed by
              reaching the database directly.
            </Banner>
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
              {roleRows.map((role) => (
                <Card
                  key={role.id}
                  title={role.name}
                  subtitle={`${role.permissions.length} permission(s) · ${role.userCount} user(s)`}
                  actions={
                    <div className="row" style={{ gap: 6 }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingRole(role);
                          setRoleOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={role.isSystem} onClick={() => void removeRole(role)}>
                        Delete
                      </Button>
                    </div>
                  }
                >
                  <div className="stack stack--sm">
                    {role.isSystem ? <Badge tone="accent">Built-in role</Badge> : <Badge>Custom role</Badge>}
                    <p className="small muted" style={{ margin: 0 }}>
                      {role.description || 'No description'}
                    </p>
                    <div className="row row--wrap" style={{ gap: 6 }}>
                      {role.permissions.slice(0, 12).map((permission) => (
                        <span key={permission} className="chip mono">
                          {permission}
                        </span>
                      ))}
                      {role.permissions.length > 12 ? <span className="small muted">+{role.permissions.length - 12} more</span> : null}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )
      ) : null}

      <UserDialog open={userOpen} user={editingUser} roles={roleRows} onClose={() => setUserOpen(false)} onSaved={() => users.reload()} />
      <ResetPasswordDialog open={resetTarget !== null} user={resetTarget} onClose={() => setResetTarget(null)} />
      <RoleDialog
        open={roleOpen}
        role={editingRole}
        catalogue={catalogue.data ?? []}
        onClose={() => setRoleOpen(false)}
        onSaved={() => roles.reload()}
      />
    </Page>
  );
}
