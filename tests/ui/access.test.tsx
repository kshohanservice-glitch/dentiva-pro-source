/**
 * Role-aware navigation and real enforcement.
 *
 * Two separate guarantees are checked here: the sidebar renders exactly the
 * screens the signed-in role can open (derived from the permission catalogue,
 * so it can never drift), and the core refuses the methods behind the screens
 * that are hidden — hiding a link is never the only guard.
 *
 * The receptionist preset is the interesting case: the front desk *does* raise
 * invoices and take payments, but has no accounting, reporting, audit or user
 * administration. The expectations below are the preset's own grants.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { permissionMatches } from '@shared/permissions';
import { NAV_SECTIONS } from '@renderer/components/layout';
import { createReadyUiApp, DEFAULT_PASSWORD, type UiApp } from './harness';

const apps: UiApp[] = [];
const RECEPTION_PASSWORD = 'Reception-2026';

async function receptionistApp(): Promise<UiApp> {
  const uiApp = await createReadyUiApp({}, { signIn: false, render: false });
  apps.push(uiApp);
  await uiApp.invoke('auth.login', { username: 'owner', password: DEFAULT_PASSWORD });
  const role = uiApp.app.services.users.listRoles().find((candidate) => candidate.key === 'receptionist');
  if (!role) throw new Error('The receptionist preset role is missing.');
  await uiApp.app.services.users.create({
    username: 'reception1',
    fullName: 'Reception Desk',
    email: '',
    phone: '',
    isActive: true,
    mustChangePassword: false,
    roleIds: [role.id],
    password: RECEPTION_PASSWORD,
  });
  await uiApp.invoke('auth.logout');
  await uiApp.invoke('auth.login', { username: 'reception1', password: RECEPTION_PASSWORD });
  uiApp.renderApp('/');
  await screen.findByRole('heading', { name: 'Dashboard' });
  return uiApp;
}

afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

describe('role-aware access', () => {
  it('renders exactly the navigation a receptionist may open', async () => {
    const uiApp = await receptionistApp();
    const session = await uiApp.invoke('auth.session');
    expect(session?.isOwner).toBe(false);
    const granted = session?.permissions ?? [];

    const navigation = screen.getByRole('navigation', { name: /Main navigation/ });
    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        const allowed = permissionMatches(granted, item.permission);
        const link = within(navigation).queryByRole('link', { name: new RegExp(item.label) });
        expect(Boolean(link), `“${item.label}” visibility must follow ${item.permission}`).toBe(allowed);
      }
    }

    // The front desk raises invoices and takes payments…
    for (const label of ['Patients', 'Appointments', 'Queue', 'Invoices', 'Payments']) {
      expect(within(navigation).getByRole('link', { name: new RegExp(label) })).toBeTruthy();
    }
    // …but accounting, reports and administration are not theirs.
    for (const label of ['Accounting', 'Reports', 'Audit log', 'Users & roles', 'Staff & dentists', 'Backup & data']) {
      expect(within(navigation).queryByRole('link', { name: new RegExp(label) })).toBeNull();
    }
  });

  it('refuses the API calls behind the screens the role cannot open', async () => {
    const uiApp = await receptionistApp();

    await expect(uiApp.invoke('accounting.transactions.list', { page: 1, pageSize: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(uiApp.invoke('reports.catalogue')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(uiApp.invoke('audit.list', { page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(uiApp.invoke('users.list', { page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The work the front desk actually does still works.
    await expect(uiApp.invoke('patients.list', { page: 1, pageSize: 5 })).resolves.toBeTruthy();
    await expect(uiApp.invoke('invoices.list', { page: 1, pageSize: 5 })).resolves.toBeTruthy();
    await expect(uiApp.invoke('payments.list', { page: 1, pageSize: 5 })).resolves.toBeTruthy();
  });

  it('shows the permitted cards, and never leaks a financial figure to the front desk', async () => {
    const uiApp = await receptionistApp();
    const summary = await uiApp.invoke('dashboard.get');
    const byLabel = new Map(summary.cards.map((card) => [card.label, card]));
    expect(summary.cards.length).toBeGreaterThan(0);

    // The front desk has no inventory permission, so that card does not exist
    // for them at all (the core does not even calculate it).
    expect(byLabel.has('Stock alerts')).toBe(false);
    for (const label of ["Today's appointments", 'In the queue', 'New patients this month', 'Follow-ups due']) {
      expect(byLabel.has(label)).toBe(true);
    }

    // They may raise invoices and take payments, so the money cards are listed
    // — but the amounts are withheld: no ৳ value ever reaches the screen.
    for (const label of ['Outstanding balance', 'Collected today']) {
      expect(byLabel.get(label)?.value).toBe('—');
    }
    expect(byLabel.get('Outstanding balance')?.hint).toContain('Restricted');

    const grid = () => {
      const element = document.querySelector('.stat-grid');
      if (!element) throw new Error('The dashboard card grid is not on screen yet.');
      return element as HTMLElement;
    };
    await waitFor(() => expect(grid().querySelectorAll('.stat').length).toBe(summary.cards.length));
    for (const label of byLabel.keys()) {
      expect(within(grid()).getByText(label)).toBeTruthy();
    }
    const collected = [...grid().querySelectorAll('.stat')].find((element) => element.textContent?.includes('Collected today'));
    expect(collected?.textContent).toContain('—');
    expect(collected?.textContent).not.toContain('৳');
  });
});
