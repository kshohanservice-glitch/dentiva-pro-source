/**
 * Administration: accounts, the clinical team and the accounting daybook.
 *
 * These three screens share a failure mode that a screenshot test would miss —
 * they save through methods that return nothing at all, so a dialog that treats
 * “no value came back” as a failure would close on success and stay open on
 * error. Each test therefore drives the real dialog and then reads the record
 * back out of the database through the service layer.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadyUiApp, DEFAULT_PASSWORD, type UiApp } from './harness';

const apps: UiApp[] = [];

afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

/** The navigation link with this label, once the shell has finished loading. */
async function navLink(label: string | RegExp): Promise<HTMLElement> {
  const navigation = await screen.findByRole('navigation', { name: /Main navigation/ });
  return within(navigation).findByRole('link', { name: label });
}

/**
 * The table row (or card) that contains this text, once the list has reloaded.
 * Tables render rows, the dentist list renders cards — both are supported.
 */
async function rowWith(text: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const cell = screen.getByText(text);
    const row = cell.closest('tr') ?? cell.closest('[role="row"]') ?? cell.closest('.card');
    if (!row) throw new Error(`No row or card found around “${text}”.`);
    return row as HTMLElement;
  });
}

describe('users and roles', () => {
  it('creates an account through the dialog and lets it sign in with the role it was given', async () => {
    const uiApp = await createReadyUiApp();
    apps.push(uiApp);
    await uiApp.user.click(await navLink('Users & roles'));
    await screen.findByRole('heading', { name: 'Users & roles' });

    await uiApp.user.click(screen.getByRole('button', { name: /New user/ }));
    const dialog = await screen.findByRole('dialog', { name: /New user/ });
    await uiApp.user.type(within(dialog).getByLabelText(/^Username/), 'drkarim');
    await uiApp.user.type(within(dialog).getByLabelText(/^Full name/), 'Dr. Karim Hossain');
    await uiApp.user.type(within(dialog).getByLabelText(/^Initial password/), DEFAULT_PASSWORD);
    await uiApp.user.type(within(dialog).getByLabelText(/^Repeat password/), DEFAULT_PASSWORD);
    await uiApp.user.click(within(dialog).getByRole('checkbox', { name: /^Dentist/ }));

    const save = within(dialog).getByRole('button', { name: /Save user/ });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    await uiApp.user.click(save);

    // The dialog closes only after the write succeeded, and the row is listed.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /New user/ })).toBeNull());
    expect(await screen.findByText('drkarim')).toBeTruthy();
    const created = (await uiApp.invoke('users.list', { page: 1, pageSize: 50 })).items.find((user) => user.username === 'drkarim');
    expect(created?.fullName).toBe('Dr. Karim Hossain');
    expect(created?.roleNames.some((role) => /dentist/i.test(role))).toBe(true);

    // The new account signs in with the initial password…
    await uiApp.invoke('auth.logout');
    const session = await uiApp.invoke('auth.login', { username: 'drkarim', password: DEFAULT_PASSWORD });
    expect(session.username).toBe('drkarim');
    // …and is refused administration, while clinical work stays open to them.
    await expect(uiApp.invoke('users.list', { page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(uiApp.invoke('patients.list', { page: 1, pageSize: 5 })).resolves.toBeTruthy();
  });
});

describe('staff and dentists', () => {
  it('adds a dentist with a qualification and shows it on the team list', async () => {
    const uiApp = await createReadyUiApp();
    apps.push(uiApp);
    await uiApp.user.click(await navLink('Staff & dentists'));
    await screen.findByRole('heading', { name: 'Staff & dentists' });

    await uiApp.user.click(screen.getByRole('tab', { name: /Dentists/ }));
    await uiApp.user.click(screen.getByRole('button', { name: /Add dentist/ }));
    const dialog = await screen.findByRole('dialog', { name: /New dentist/ });
    await uiApp.user.type(within(dialog).getByLabelText(/^Full name/), 'Dr. Karim Hossain');
    await uiApp.user.type(within(dialog).getByLabelText(/^Registration number/), 'BDS-7712');
    await uiApp.user.click(within(dialog).getByRole('button', { name: /Add line/ }));
    await uiApp.user.type(await within(dialog).findByLabelText(/^Title/), 'BDS');
    await uiApp.user.type(within(dialog).getByLabelText(/^Institution/), 'Dhaka Dental College');

    const save = within(dialog).getByRole('button', { name: /Save dentist/ });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    await uiApp.user.click(save);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /New dentist/ })).toBeNull());
    const stored = await waitFor(() => {
      const found = uiApp.app.services.dentists.list().find((dentist) => dentist.name === 'Dr. Karim Hossain');
      if (!found) throw new Error('The dentist is not in the database yet.');
      return found;
    });
    expect(stored.registrationNumber).toBe('BDS-7712');
    expect(uiApp.app.services.dentists.credentials(stored.id).map((credential) => credential.title)).toContain('BDS');
    const card = await rowWith('Dr. Karim Hossain');
    expect(within(card).getByText('BDS-7712')).toBeTruthy();
    // The qualification is listed, and it is marked as shown on prescriptions.
    expect(within(card).getByText('BDS')).toBeTruthy();
  });
});

describe('accounting', () => {
  it('records an expense and edits it through the same dialog', async () => {
    const uiApp = await createReadyUiApp();
    apps.push(uiApp);
    await uiApp.user.click(await navLink('Accounting'));
    await screen.findByRole('heading', { name: 'Accounting' });

    await uiApp.user.click(screen.getByRole('button', { name: /New entry/ }));
    const dialog = await screen.findByRole('dialog', { name: /Record expense/ });
    const category = within(dialog)
      .getAllByRole('combobox')
      .find((select) => within(select as HTMLElement).queryByRole('option', { name: /Clinic rent/ }) !== null);
    if (!category) throw new Error('The expense category list is empty.');
    const rentOption = within(category as HTMLElement).getByRole('option', { name: /Clinic rent/ });
    await uiApp.user.selectOptions(category, (rentOption as HTMLOptionElement).value);
    const amount = within(dialog).getByLabelText(/^Amount/);
    await uiApp.user.clear(amount);
    await uiApp.user.type(amount, '3500');
    await uiApp.user.type(within(dialog).getByLabelText(/^Note/), 'Replaced the compressor valve');

    const save = within(dialog).getByRole('button', { name: /Save entry/ });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    await uiApp.user.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Record expense/ })).toBeNull());

    const recorded = await waitFor(async () => {
      const listed = await uiApp.invoke('accounting.transactions.list', { page: 1, pageSize: 50 });
      const entry = listed.items.find((item) => item.note === 'Replaced the compressor valve');
      if (!entry) throw new Error('The expense is not in the daybook yet.');
      return entry;
    });
    expect(recorded.direction).toBe('expense');
    expect(recorded.amountPaisa).toBe(350_000);
    expect(recorded.categoryName).toBe('Clinic rent');
    expect(screen.getByText('−৳3,500')).toBeTruthy();
    expect((await uiApp.invoke('accounting.summary', {})).expensePaisa).toBe(350_000);

    // Editing goes through the void-returning update path: the dialog may only
    // close when the write actually went through.
    const entryRow = await rowWith('Replaced the compressor valve');
    await uiApp.user.click(within(entryRow).getByRole('button', { name: 'Edit' }));
    const editDialog = await screen.findByRole('dialog', { name: 'Edit transaction' });
    const editAmount = within(editDialog).getByLabelText(/^Amount/);
    await uiApp.user.clear(editAmount);
    await uiApp.user.type(editAmount, '4200');
    await uiApp.user.click(within(editDialog).getByRole('button', { name: /Save entry/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit transaction' })).toBeNull());

    const updated = await waitFor(async () => {
      const listed = await uiApp.invoke('accounting.transactions.list', { page: 1, pageSize: 50 });
      const entry = listed.items.find((item) => item.note === 'Replaced the compressor valve');
      if (entry?.amountPaisa !== 420_000) throw new Error('The edited amount is not stored yet.');
      return entry;
    });
    expect(updated.amountPaisa).toBe(420_000);
    expect((await uiApp.invoke('accounting.summary', {})).expensePaisa).toBe(420_000);
  });
});
