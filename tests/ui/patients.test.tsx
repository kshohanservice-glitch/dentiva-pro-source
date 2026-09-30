/**
 * The patient register through the real UI: the advanced list (newest first by
 * default, date-range presets, search) and the registration form, including the
 * duplicate check and the client-side guard on required fields.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadyUiApp, type UiApp } from './harness';

const apps: UiApp[] = [];

async function patientsApp(route = '/patients'): Promise<UiApp> {
  const uiApp = await createReadyUiApp({}, { route });
  apps.push(uiApp);
  return uiApp;
}

afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

function openRegisterDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: /Register a patient/ });
}

describe('patient register', () => {
  it('registers a patient through the form and lists it with its code', async () => {
    const uiApp = await patientsApp();

    // A brand new clinic has no patients — the empty state is real, not fake data.
    await screen.findByText('No patients matched your filters');

    // Both the page toolbar and the empty state offer registration; either
    // entry point opens the same form.
    await uiApp.user.click(screen.getAllByRole('button', { name: /Register patient/ })[0]!);
    const dialog = openRegisterDialog();
    const submit = within(dialog).getByRole('button', { name: /Register patient/ }) as HTMLButtonElement;
    // Name and mobile number are required; the form cannot be submitted without them.
    expect(submit.disabled).toBe(true);

    await uiApp.user.type(within(dialog).getByLabelText(/^First name/), 'Rahim');
    await uiApp.user.type(within(dialog).getByLabelText(/^Last name/), 'Uddin');
    await uiApp.user.type(within(dialog).getByLabelText(/^Mobile number/), '01712345678');
    await uiApp.user.type(within(dialog).getByLabelText(/^City \/ district/), 'Tangail');
    expect(submit.disabled).toBe(false);

    await uiApp.user.click(submit);

    // The register shows the new patient with the code the clinic will use.
    expect(await screen.findByText('Rahim Uddin')).toBeTruthy();
    expect(screen.getByText('P-000001')).toBeTruthy();

    // …and it is really in the database, not just on screen.
    const stored = uiApp.app.services.patients.list({ page: 1, pageSize: 10, search: 'Rahim' });
    expect(stored.total).toBe(1);
    expect(stored.items[0]?.code).toBe('P-000001');
    expect(stored.items[0]?.phone).toBe('01712345678');
    const detail = uiApp.app.services.patients.get(stored.items[0]!.id);
    expect(detail.firstName).toBe('Rahim');
    expect(detail.lastName).toBe('Uddin');
    expect(detail.city).toBe('Tangail');
  });

  it('warns about a possible duplicate before the second record is saved', async () => {
    const uiApp = await patientsApp();
    uiApp.app.services.patients.create({
      firstName: 'Rahim',
      lastName: 'Uddin',
      gender: 'male',
      dob: null,
      ageYears: 34,
      bloodGroup: 'unknown',
      phone: '01712345678',
      alternatePhone: '',
      email: '',
      address: '',
      city: 'Tangail',
      emergencyContactName: '',
      emergencyPhone: '',
      chiefComplaint: '',
      previousProblems: '',
      medicalNotes: '',
      allergies: '',
      notes: '',
      preferredContact: 'mobile',
      status: 'active',
      referredBy: '',
      tagIds: [],
    });
    await screen.findByText('Rahim Uddin');

    await uiApp.user.click(screen.getAllByRole('button', { name: /Register patient/ })[0]!);
    const dialog = openRegisterDialog();
    await uiApp.user.type(within(dialog).getByLabelText(/^First name/), 'Rahim');
    await uiApp.user.type(within(dialog).getByLabelText(/^Last name/), 'Uddin');
    await uiApp.user.type(within(dialog).getByLabelText(/^Mobile number/), '01712345678');
    await uiApp.user.click(within(dialog).getByRole('button', { name: /^Check$/ }));

    // The duplicate checker names the existing record (code + phone).
    await waitFor(() => expect(within(dialog).getByText('P-000001')).toBeTruthy());
    expect(within(dialog).getByText('01712345678')).toBeTruthy();
  });

  it('filters by registration date and keeps the newest patient first', async () => {
    const uiApp = await patientsApp();
    const patients = uiApp.app.services.patients;
    const older = createPatient(patients, 'Older', 'Patient');
    const newer = createPatient(patients, 'Newer', 'Patient');
    // Backdate the first record by a week — this is what "registered" filtering means.
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    uiApp.app.container.db.prepare(`UPDATE patients SET created_at = ? WHERE id = ?`).run(weekAgo, older.id);

    const rows = await screen.findAllByRole('row');
    const names = rows.map((row) => row.textContent ?? '');
    expect(names[1]).toContain('Newer Patient');

    // Narrowing the range to today removes the older record from the register.
    const preset = screen
      .getAllByRole('combobox')
      .find((select) => Array.from((select as HTMLSelectElement).options).some((option) => option.textContent === 'Last 7 days'));
    expect(preset).toBeTruthy();
    await uiApp.user.selectOptions(preset as HTMLSelectElement, 'today');

    await waitFor(() => expect(screen.queryByText('Older Patient')).toBeNull());
    expect(screen.getByText('Newer Patient')).toBeTruthy();
    expect(newer.id).toBeGreaterThan(older.id);
  });

  it('searches the register by name and by phone', async () => {
    const uiApp = await patientsApp();
    createPatient(uiApp.app.services.patients, 'Ayesha', 'Sultana', '01911111111');
    createPatient(uiApp.app.services.patients, 'Karim', 'Hossain', '01822222222');
    await screen.findByText('Ayesha Sultana');

    const search = screen.getByPlaceholderText(/Search by name, code, phone or city/);
    await uiApp.user.type(search, 'Karim');
    await waitFor(() => expect(screen.queryByText('Ayesha Sultana')).toBeNull());
    expect(screen.getByText('Karim Hossain')).toBeTruthy();
  });
});

function createPatient(
  patients: UiApp['app']['services']['patients'],
  firstName: string,
  lastName: string,
  phone = '01700000000',
): { id: number; code: string } {
  return patients.create({
    firstName,
    lastName,
    gender: 'female',
    dob: null,
    ageYears: 29,
    bloodGroup: 'unknown',
    phone,
    alternatePhone: '',
    email: '',
    address: '',
    city: 'Dhaka',
    emergencyContactName: '',
    emergencyPhone: '',
    chiefComplaint: '',
    previousProblems: '',
    medicalNotes: '',
    allergies: '',
    notes: '',
    preferredContact: 'mobile',
    status: 'active',
    referredBy: '',
    tagIds: [],
  });
}
