/**
 * Staff and dentists.
 *
 * Both live on this screen because they are two views of the clinical team:
 * staff covers reception, assistance and administration, while dentists carry
 * the designations, qualifications and certifications that are printed on
 * prescriptions.
 */
import { useEffect, useState } from 'react';
import { Award, IdCard, Plus, Stethoscope, Trash2, UsersRound } from 'lucide-react';
import { BLOOD_GROUPS, DENTIST_CREDENTIAL_TYPES } from '@shared/constants';
import type { BloodGroup, DentistCredentialType } from '@shared/constants';
import { todayIso } from '@shared/dates';
import type { Dentist, DentistInput, StaffInput, StaffMember } from '@shared/types';
import { useAction, useApi, useApp } from '@renderer/state/store';
import { bridge, resolveSourcePath } from '@renderer/lib/bridge';
import { fmtAge, fmtDate, fmtMoney } from '@renderer/lib/format';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  LoadingBlock,
  Modal,
  Page,
  SearchInput,
  Select,
  Stat,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
} from '@renderer/components/ui';
import { DataTable, DateField, MoneyField, PagedFooter, TextField, useListState } from '@renderer/components/forms';

const STAFF_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'on_leave', label: 'On leave' },
  { value: 'resigned', label: 'Resigned' },
];

const EMPTY_STAFF: StaffInput = {
  name: '',
  designation: '',
  department: '',
  phone: '',
  email: '',
  address: '',
  dob: null,
  bloodGroup: 'unknown',
  nationalId: '',
  salaryPaisa: null,
  joiningDate: todayIso(),
  status: 'active',
  notes: '',
  userId: null,
};

function StaffDialog({
  open,
  member,
  departments,
  onClose,
  onSaved,
}: {
  open: boolean;
  member: StaffMember | null;
  departments: readonly string[];
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { run, busy } = useAction();
  const [form, setForm] = useState<StaffInput>(EMPTY_STAFF);
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState('');
  const patch = (value: Partial<StaffInput>) => setForm((current) => ({ ...current, ...value }));

  useEffect(() => {
    if (member) {
      setForm({
        name: member.name,
        designation: member.designation,
        department: member.department,
        phone: member.phone,
        email: member.email,
        address: member.address,
        dob: member.dob,
        bloodGroup: member.bloodGroup,
        nationalId: member.nationalId,
        salaryPaisa: member.salaryPaisa,
        joiningDate: member.joiningDate,
        status: member.status,
        notes: member.notes,
        userId: member.userId,
      });
    } else {
      setForm({ ...EMPTY_STAFF });
      setPhotoPath(null);
      setPhotoName('');
    }
  }, [member]);

  if (!open) return null;

  return (
    <Modal
      open
      width="wide"
      title={member ? `Edit ${member.name}` : 'New staff member'}
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={form.name.trim().length < 2}
            onClick={async () => {
              const saved = await run(
                () => bridge.invoke('staff.save', { id: member?.id ?? null, input: form, photoSourcePath: photoPath }),
                { success: member ? 'Staff member updated.' : 'Staff member added.', failure: 'The staff member could not be saved.' },
              );
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <TextField label="Full name" required value={form.name} onChange={(value) => patch({ name: value })} />
          <TextField label="Designation" value={form.designation} onChange={(value) => patch({ designation: value })} />
          <Field label="Department" hint="Type a new department or reuse an existing one">
            <Input list="staff-departments" value={form.department} onChange={(event) => patch({ department: event.target.value })} />
            <datalist id="staff-departments">
              {departments.map((department) => (
                <option key={department} value={department} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="grid-3">
          <TextField label="Phone" value={form.phone} onChange={(value) => patch({ phone: value })} />
          <TextField label="Email" value={form.email} onChange={(value) => patch({ email: value })} />
          <TextField label="National ID" value={form.nationalId} onChange={(value) => patch({ nationalId: value })} />
        </div>
        <div className="grid-3">
          <DateField label="Date of birth" value={form.dob ?? ''} onChange={(value) => patch({ dob: value || null })} />
          <Field label="Blood group">
            <Select
              value={form.bloodGroup}
              options={BLOOD_GROUPS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(event) => patch({ bloodGroup: event.target.value as BloodGroup })}
            />
          </Field>
          <Field label="Status">
            <Select
              value={form.status}
              options={STAFF_STATUSES}
              onChange={(event) => patch({ status: event.target.value as StaffInput['status'] })}
            />
          </Field>
        </div>
        <div className="grid-3">
          <DateField label="Joining date" value={form.joiningDate ?? ''} onChange={(value) => patch({ joiningDate: value || null })} />
          <MoneyField label="Monthly salary" valuePaisa={form.salaryPaisa ?? 0} onChange={(paisa) => patch({ salaryPaisa: paisa })} />
          <Field label="Photo" hint="Shown on the staff list">
            <div className="row" style={{ gap: 8 }}>
              <label className="btn btn--ghost btn--sm">
                Choose image
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: 'none' }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      setPhotoPath(await resolveSourcePath(file));
                      setPhotoName(file.name);
                    } catch {
                      setPhotoName('');
                    }
                  }}
                />
              </label>
              <span className="small muted">{photoName || (member?.photoPath ? 'Existing photo kept' : 'No photo')}</span>
            </div>
          </Field>
        </div>
        <Field label="Address">
          <TextArea rows={2} value={form.address} onChange={(event) => patch({ address: event.target.value })} />
        </Field>
        <Field label="Notes">
          <TextArea rows={2} value={form.notes} onChange={(event) => patch({ notes: event.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function blankDentist(): DentistInput {
  return {
    name: '',
    phone: '',
    email: '',
    registrationNumber: '',
    visitingHours: '',
    isActive: true,
    isDefault: false,
    credentials: [],
  };
}

function DentistDialog({
  open,
  dentist,
  onClose,
  onSaved,
}: {
  open: boolean;
  dentist: Dentist | null;
  onClose(): void;
  onSaved(): void;
}): JSX.Element | null {
  const { run, busy } = useAction();
  const [form, setForm] = useState<DentistInput>(blankDentist());
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [signaturePath, setSignaturePath] = useState<string | null>(null);
  const patch = (value: Partial<DentistInput>) => setForm((current) => ({ ...current, ...value }));

  useEffect(() => {
    if (dentist) {
      setForm({
        name: dentist.name,
        phone: dentist.phone,
        email: dentist.email,
        registrationNumber: dentist.registrationNumber,
        visitingHours: dentist.visitingHours,
        isActive: dentist.isActive,
        isDefault: dentist.isDefault,
        credentials: dentist.credentials.map((credential) => ({
          id: credential.id,
          type: credential.type,
          title: credential.title,
          institution: credential.institution,
          year: credential.year,
          sortOrder: credential.sortOrder,
          showOnPrescription: credential.showOnPrescription,
        })),
      });
    } else {
      setForm(blankDentist());
      setPhotoPath(null);
      setSignaturePath(null);
    }
  }, [dentist]);

  if (!open) return null;

  return (
    <Modal
      open
      width="wide"
      title={dentist ? `Edit ${dentist.name}` : 'New dentist'}
      description="Credentials marked “on prescription” are printed under the signature."
      onClose={onClose}
      footer={
        <div className="row row--end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={form.name.trim().length < 2}
            onClick={async () => {
              const saved = await run(
                () =>
                  bridge.invoke('dentists.save', {
                    id: dentist?.id ?? null,
                    input: form,
                    photoSourcePath: photoPath,
                    signatureSourcePath: signaturePath,
                  }),
                { success: 'Dentist saved.', failure: 'The dentist could not be saved.' },
              );
              if (saved) {
                onSaved();
                onClose();
              }
            }}
          >
            Save dentist
          </Button>
        </div>
      }
    >
      <div className="stack">
        <div className="grid-3">
          <TextField label="Full name" required value={form.name} onChange={(value) => patch({ name: value })} />
          <TextField
            label="Registration number"
            hint="BMDC or equivalent"
            value={form.registrationNumber}
            onChange={(value) => patch({ registrationNumber: value })}
          />
          <TextField label="Visiting hours" value={form.visitingHours} onChange={(value) => patch({ visitingHours: value })} />
        </div>
        <div className="grid-3">
          <TextField label="Phone" value={form.phone} onChange={(value) => patch({ phone: value })} />
          <TextField label="Email" value={form.email} onChange={(value) => patch({ email: value })} />
          <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
            <Switch label="Active" checked={form.isActive} onChange={(value) => patch({ isActive: value })} />
            <Switch label="Default" checked={form.isDefault} onChange={(value) => patch({ isDefault: value })} />
          </div>
        </div>
        <div className="grid-2">
          <Field label="Photo" hint="Shown on the team list">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) setPhotoPath(await resolveSourcePath(file));
              }}
            />
          </Field>
          <Field label="Signature image" hint="Optional; used on printed prescriptions">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) setSignaturePath(await resolveSourcePath(file));
              }}
            />
          </Field>
        </div>

        <Card
          title="Designations, qualifications and certifications"
          actions={
            <Button
              size="sm"
              icon={<Plus size={14} />}
              onClick={() =>
                patch({
                  credentials: [
                    ...form.credentials,
                    {
                      id: null,
                      type: 'qualification',
                      title: '',
                      institution: '',
                      year: null,
                      sortOrder: (form.credentials.length + 1) * 10,
                      showOnPrescription: true,
                    },
                  ],
                })
              }
            >
              Add line
            </Button>
          }
        >
          {form.credentials.length === 0 ? (
            <p className="muted small">
              No credentials yet. For example: “BDS” (qualification), “Consultant, Orthodontics” (designation) or “Advanced Endodontics,
              2024” (certification).
            </p>
          ) : (
            <div className="stack stack--sm">
              {form.credentials.map((credential, index) => (
                <div key={index} className="grid-4">
                  <Field label="Type">
                    <Select
                      value={credential.type}
                      options={DENTIST_CREDENTIAL_TYPES.map((option) => ({ value: option.value, label: option.label }))}
                      onChange={(event) => {
                        const next = [...form.credentials];
                        next[index] = { ...credential, type: event.target.value as DentistCredentialType };
                        patch({ credentials: next });
                      }}
                    />
                  </Field>
                  <TextField
                    label="Title"
                    value={credential.title}
                    onChange={(value) => {
                      const next = [...form.credentials];
                      next[index] = { ...credential, title: value };
                      patch({ credentials: next });
                    }}
                  />
                  <TextField
                    label="Institution"
                    value={credential.institution}
                    onChange={(value) => {
                      const next = [...form.credentials];
                      next[index] = { ...credential, institution: value };
                      patch({ credentials: next });
                    }}
                  />
                  <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
                    <Field label="Year">
                      <Input
                        className="input--numeric"
                        value={credential.year === null ? '' : String(credential.year)}
                        onChange={(event) => {
                          const next = [...form.credentials];
                          next[index] = { ...credential, year: event.target.value ? Number(event.target.value) : null };
                          patch({ credentials: next });
                        }}
                      />
                    </Field>
                    <Switch
                      label="On prescription"
                      checked={credential.showOnPrescription}
                      onChange={(value) => {
                        const next = [...form.credentials];
                        next[index] = { ...credential, showOnPrescription: value };
                        patch({ credentials: next });
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Remove credential"
                      onClick={() => patch({ credentials: form.credentials.filter((_, position) => position !== index) })}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </Modal>
  );
}

export function StaffScreen(): JSX.Element {
  const { confirm } = useApp();
  const { run } = useAction();
  const lists = useListState();
  const [tab, setTab] = useState('staff');
  const [status, setStatus] = useState('');
  const [department, setDepartment] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [staffOpen, setStaffOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  const [dentistOpen, setDentistOpen] = useState(false);
  const [editingDentist, setEditingDentist] = useState<Dentist | null>(null);

  const staffList = useApi(
    'staff.list',
    tab === 'staff'
      ? { ...lists.state, search: lists.state.search || undefined, status: status ? [status] : undefined, department: department || null }
      : null,
    [tab, lists.state.page, lists.state.search, status, department],
  );
  const staffStats = useApi('staff.statistics', tab === 'staff' ? undefined : null, [tab]);
  const departments = useApi('staff.departments', undefined);
  const dentists = useApi('dentists.list', tab === 'dentists' ? { includeInactive } : null, [tab, includeInactive]);
  const dentistStats = useApi('dentists.statistics', tab === 'dentists' ? { preset: lists.state.preset || 'this_month' } : null, [
    tab,
    lists.state.preset,
  ]);

  const staffRows = staffList.data?.items ?? [];

  const removeStaff = async (member: StaffMember) => {
    const answer = await confirm({
      title: `Remove ${member.name}`,
      description: 'Staff records with history are deactivated instead of deleted.',
      confirmLabel: 'Remove staff member',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    await run(() => bridge.invoke('staff.delete', { id: member.id, reason: answer.reason!, confirmText: member.name }), {
      success: 'Staff member removed.',
    });
    staffList.reload();
    staffStats.reload();
  };

  const removeDentist = async (dentist: Dentist) => {
    const answer = await confirm({
      title: `Remove ${dentist.name}`,
      description: 'A dentist who has recorded visits is deactivated so prescriptions and invoices stay attributable.',
      confirmLabel: 'Remove dentist',
      tone: 'danger',
      reason: true,
    });
    if (!answer.ok || !answer.reason) return;
    await run(() => bridge.invoke('dentists.delete', { id: dentist.id, reason: answer.reason!, confirmText: dentist.name }), {
      success: 'Dentist removed.',
    });
    dentists.reload();
    dentistStats.reload();
  };

  return (
    <Page
      title="Staff & dentists"
      description="The clinical team, their credentials and their workload"
      actions={
        tab === 'staff' ? (
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setEditingStaff(null);
              setStaffOpen(true);
            }}
          >
            Add staff
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => {
              setEditingDentist(null);
              setDentistOpen(true);
            }}
          >
            Add dentist
          </Button>
        )
      }
    >
      <Tabs
        tabs={[
          { key: 'staff', label: 'Staff', count: staffStats.data?.total },
          { key: 'dentists', label: 'Dentists', count: dentists.data?.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'staff' ? (
        <>
          <div className="stat-grid">
            <Stat label="Team members" value={String(staffStats.data?.total ?? 0)} icon={<UsersRound size={16} />} />
            <Stat label="Currently active" value={String(staffStats.data?.active ?? 0)} tone="success" />
            {(staffStats.data?.byDepartment ?? []).slice(0, 4).map((entry) => (
              <Stat key={entry.label} label={entry.label || 'Unassigned'} value={String(entry.value)} />
            ))}
          </div>

          <div className="filters">
            <div className="row row--wrap" style={{ gap: 10 }}>
              <div style={{ minWidth: 240, flex: 1 }}>
                <SearchInput
                  value={lists.state.search}
                  placeholder="Search name, designation, phone…"
                  onChange={(value) => lists.patch({ search: value })}
                />
              </div>
              <Select
                value={status}
                placeholder="All statuses"
                options={STAFF_STATUSES}
                onChange={(event) => setStatus(event.target.value)}
              />
              <Select
                value={department}
                placeholder="All departments"
                options={(departments.data ?? []).map((entry) => ({ value: entry, label: entry }))}
                onChange={(event) => setDepartment(event.target.value)}
              />
            </div>
          </div>

          <Card padded={false}>
            <DataTable
              columns={[
                { key: 'name', label: 'Name' },
                { key: 'designation', label: 'Designation' },
                { key: 'department', label: 'Department' },
                { key: 'contact', label: 'Contact' },
                { key: 'joined', label: 'Joined' },
                { key: 'salary', label: 'Salary', align: 'right' },
                { key: 'status', label: 'Status' },
                { key: 'actions', label: '', align: 'right' },
              ]}
              rows={staffRows.map((member) => ({
                name: (
                  <div className="row" style={{ gap: 10 }}>
                    <Avatar name={member.name} size={30} src={null} />
                    <div>
                      <div>{member.name}</div>
                      <div className="small muted">{fmtAge({ dob: member.dob })}</div>
                    </div>
                  </div>
                ),
                designation: member.designation || '—',
                department: member.department || '—',
                contact: (
                  <div>
                    <div>{member.phone || '—'}</div>
                    <div className="small muted">{member.email || '—'}</div>
                  </div>
                ),
                joined: member.joiningDate ? fmtDate(member.joiningDate) : '—',
                salary: member.salaryPaisa === null ? '—' : fmtMoney(member.salaryPaisa),
                status: <StatusBadge status={member.status} label={member.status.replace(/_/g, ' ')} />,
                actions: (
                  <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingStaff(member);
                        setStaffOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void removeStaff(member)}>
                      Remove
                    </Button>
                  </div>
                ),
              }))}
              loading={staffList.loading && !staffList.data}
              error={staffList.error}
              onRetry={staffList.reload}
              rowKey={(index) => String(staffRows[index]?.id ?? index)}
              empty={<Empty title="No staff recorded" text="Add receptionists, assistants and administrators here." />}
            />
            <PagedFooter page={lists.state.page} onPage={(page) => lists.patch({ page })} data={staffList.data} />
          </Card>
        </>
      ) : null}

      {tab === 'dentists' ? (
        <>
          <div className="filters">
            <div className="row row--wrap" style={{ gap: 10 }}>
              <Select
                value={lists.state.preset}
                placeholder="This month"
                options={[
                  { value: 'today', label: 'Today' },
                  { value: 'this_week', label: 'This week' },
                  { value: 'this_month', label: 'This month' },
                  { value: 'this_year', label: 'This year' },
                ]}
                onChange={(event) => lists.patch({ preset: event.target.value })}
              />
              <Switch label="Show inactive" checked={includeInactive} onChange={setIncludeInactive} />
            </div>
          </div>

          {dentists.loading && !dentists.data ? (
            <LoadingBlock rows={4} />
          ) : (dentists.data ?? []).length === 0 ? (
            <Empty title="No dentists yet" text="A dentist is required before a visit can be recorded." icon={<Stethoscope size={24} />} />
          ) : (
            <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
              {(dentists.data ?? []).map((dentist) => {
                const stats = (dentistStats.data ?? []).find((entry) => entry.dentistId === dentist.id);
                return (
                  <Card
                    key={dentist.id}
                    title={dentist.name}
                    subtitle={dentist.registrationNumber || 'Registration not recorded'}
                    actions={
                      <div className="row" style={{ gap: 6 }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingDentist(dentist);
                            setDentistOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void removeDentist(dentist)}>
                          Remove
                        </Button>
                      </div>
                    }
                  >
                    <div className="stack stack--sm">
                      <div className="row" style={{ gap: 10 }}>
                        <Avatar name={dentist.name} size={40} src={null} />
                        <div>
                          {dentist.isDefault ? <Badge tone="accent">Default dentist</Badge> : null}
                          {!dentist.isActive ? <Badge tone="warning">Inactive</Badge> : null}
                          <div className="small muted" style={{ marginTop: 4 }}>
                            {dentist.visitingHours || 'Visiting hours not recorded'}
                          </div>
                        </div>
                      </div>
                      <div className="small muted">
                        {dentist.phone || '—'} · {dentist.email || '—'}
                      </div>
                      <div>
                        <div className="small muted" style={{ marginBottom: 4 }}>
                          <IdCard size={13} /> Credentials
                        </div>
                        {dentist.credentials.length === 0 ? (
                          <span className="small muted">None recorded</span>
                        ) : (
                          <div className="row row--wrap" style={{ gap: 6 }}>
                            {dentist.credentials.map((credential) => (
                              <span key={credential.id} className="chip">
                                {credential.title || credential.type}
                                {credential.showOnPrescription ? '' : ' (hidden on Rx)'}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="grid-3">
                        <Stat label="Appointments" value={String(stats?.appointments ?? 0)} />
                        <Stat label="Visits" value={String(stats?.visits ?? 0)} />
                        <Stat label="Prescriptions" value={String(stats?.prescriptions ?? 0)} />
                      </div>
                      <div className="row row--between small">
                        <span className="muted">
                          <Award size={13} /> Completed {stats?.completed ?? 0} · no-shows {stats?.noShows ?? 0}
                        </span>
                        <span>{stats?.revenuePaisa === null || stats?.revenuePaisa === undefined ? '' : fmtMoney(stats.revenuePaisa)}</span>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      <StaffDialog
        open={staffOpen}
        member={editingStaff}
        departments={departments.data ?? []}
        onClose={() => setStaffOpen(false)}
        onSaved={() => {
          staffList.reload();
          staffStats.reload();
          departments.reload();
        }}
      />
      <DentistDialog
        open={dentistOpen}
        dentist={editingDentist}
        onClose={() => setDentistOpen(false)}
        onSaved={() => {
          dentists.reload();
          dentistStats.reload();
        }}
      />
    </Page>
  );
}
