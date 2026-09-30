/**
 * The application gate and shell, driven through the real UI.
 *
 * Nothing is mocked: the wizard, the sign-in form, the sidebar and the lock
 * screen talk to the real IPC router, the real zod schemas and a real SQLite
 * database. A click here is the same click the clinic owner makes.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createUiApp, DEFAULT_PASSWORD, type UiApp } from './harness';

const apps: UiApp[] = [];

function app(): UiApp {
  const created = createUiApp();
  apps.push(created);
  return created;
}

afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

async function signIn(uiApp: UiApp, username = 'owner', password = DEFAULT_PASSWORD, fullName = 'Clinic Owner'): Promise<void> {
  const usernameField = await screen.findByLabelText(/Username/);
  await uiApp.user.type(usernameField, username);
  await uiApp.user.type(screen.getByLabelText(/Password/), password);
  await uiApp.user.click(screen.getByRole('button', { name: /Sign in/ }));
  await screen.findByRole('heading', { name: 'Dashboard' });
  expect(screen.getByRole('button', { name: new RegExp(fullName) })).toBeTruthy();
}

describe('activation gate', () => {
  it('refuses to open anything until the licence code is entered', async () => {
    const uiApp = app();
    uiApp.renderApp();

    await screen.findByRole('heading', { name: /Dentiva Pro activation/ });
    expect(screen.getByLabelText(/Activation code/)).toBeTruthy();
    // The button stays disabled until a code of a plausible length is typed.
    const activate = screen.getByRole('button', { name: /Activate/ }) as HTMLButtonElement;
    expect(activate.disabled).toBe(true);
    // No navigation, no shell, no data.
    expect(screen.queryByRole('navigation', { name: /Main navigation/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
  });
});

describe('setup wizard', () => {
  it('walks the seven steps and opens the clinic system', async () => {
    const uiApp = app();
    uiApp.activateLicense();
    uiApp.renderApp();

    await screen.findByRole('heading', { name: /Dentiva Pro setup/ });
    expect(screen.getByText('Seven short steps, saved as you go.')).toBeTruthy();
    // Seven steps are listed, and the wizard opens on the first unfinished one.
    const steps = screen.getAllByRole('button').filter((button) => button.className.includes('gate__step'));
    expect(steps.length).toBe(7);
    expect(steps.map((button) => button.textContent)).toEqual([
      expect.stringContaining('Welcome'),
      expect.stringContaining('Clinic profile'),
      expect.stringContaining('Dentists'),
      expect.stringContaining('Preferences'),
      expect.stringContaining('Administrator'),
      expect.stringContaining('Review'),
      expect.stringContaining('Finish'),
    ]);

    // Step 2 — clinic profile. The save stays disabled until the required
    // clinic name is filled in, so an incomplete profile can never be stored.
    const saveClinic = await screen.findByRole('button', { name: /Save clinic profile/ });
    expect((saveClinic as HTMLButtonElement).disabled).toBe(true);
    await uiApp.user.type(screen.getByLabelText(/^Clinic name/), 'Smile Dental Care');
    await uiApp.user.type(screen.getByLabelText(/^Phone/), '01711111111');
    await uiApp.user.type(screen.getByLabelText(/^Address/), '12 Mirpur Road, Dhaka 1205');
    await uiApp.user.click(screen.getByRole('button', { name: /Save clinic profile/ }));

    // Step 3 — dentists. The step opens with one dentist row; the add button
    // appends another (with the same validation rules).
    expect(await screen.findByRole('button', { name: /Add dentist/ })).toBeTruthy();
    const names = screen.getAllByLabelText(/^Full name/);
    expect(names.length).toBe(1);
    await uiApp.user.type(names[0]!, 'Dr. Ayesha Rahman');
    await uiApp.user.type(screen.getAllByLabelText(/BDS \/ registration number/)[0]!, 'BDS-4471');
    await uiApp.user.click(screen.getByRole('button', { name: /Save dentists/ }));

    // Step 4 — preferences keep their defaults; step 5 — the administrator.
    await uiApp.user.click(await screen.findByRole('button', { name: /Save preferences/ }));
    await uiApp.user.type(await screen.findByLabelText(/^Username/), 'owner');
    await uiApp.user.type(screen.getByLabelText(/^Repeat password/), DEFAULT_PASSWORD);
    await uiApp.user.type(screen.getByLabelText(/^Full name/), 'Clinic Owner');
    await uiApp.user.type(screen.getByLabelText(/^Password/), DEFAULT_PASSWORD);
    await uiApp.user.click(screen.getByRole('button', { name: /Create administrator/ }));

    // Step 6 — review shows what was captured, step 7 completes the wizard.
    await screen.findByText('Smile Dental Care');
    await uiApp.user.click(screen.getByRole('button', { name: /Continue/ }));
    await uiApp.user.click(await screen.findByRole('button', { name: /Complete setup and open Dentiva Pro/ }));

    // The clinic is set up and nobody is signed in: the sign-in screen.
    await screen.findByRole('button', { name: /Sign in/ });
    expect(screen.getByRole('heading', { name: 'Smile Dental Care' })).toBeTruthy();
    expect(uiApp.app.services.settings.getSetupState().completedAt).not.toBeNull();
  });
});

describe('shell', () => {
  it('signs the owner in, shows the permission-aware shell and locks the screen', async () => {
    const uiApp = app();
    uiApp.activateLicense();
    await uiApp.completeSetup({ clinicName: 'Smile Dental Care' });
    uiApp.renderApp();

    await signIn(uiApp);

    // Branding, clinic name and the four sidebar sections.
    expect(screen.getAllByText('Smile Dental Care').length).toBeGreaterThan(0);
    const navigation = screen.getByRole('navigation', { name: /Main navigation/ });
    for (const section of ['Practice', 'Clinical', 'Billing', 'Administration']) {
      expect(within(navigation).getByText(section)).toBeTruthy();
    }
    for (const link of ['Dashboard', 'Patients', 'Appointments', 'Queue', 'Invoices', 'Payments', 'Reports', 'Settings']) {
      expect(within(navigation).getByRole('link', { name: new RegExp(link) })).toBeTruthy();
    }

    // The dashboard is role-aware and starts empty rather than fake.
    const cards = await screen.findAllByText(/Patients registered|Appointments today|Collected/);
    expect(cards.length).toBeGreaterThan(0);

    // Lock the screen from the user menu and unlock it with the password.
    await uiApp.user.click(screen.getByRole('button', { name: /Clinic Owner/ }));
    await uiApp.user.click(await screen.findByRole('menuitem', { name: /Lock now/ }));
    await screen.findByRole('button', { name: /Unlock/ });
    expect(screen.queryByRole('navigation', { name: /Main navigation/ })).toBeNull();

    await uiApp.user.type(screen.getByLabelText(/Password/), DEFAULT_PASSWORD);
    await uiApp.user.click(screen.getByRole('button', { name: /Unlock/ }));
    await screen.findByRole('heading', { name: 'Dashboard' });
  });

  it('signs out and returns to the sign-in screen', async () => {
    const uiApp = app();
    uiApp.activateLicense();
    await uiApp.completeSetup({ clinicName: 'Smile Dental Care' });
    uiApp.renderApp();
    await signIn(uiApp);

    await uiApp.user.click(screen.getByRole('button', { name: /Clinic Owner/ }));
    await uiApp.user.click(await screen.findByRole('menuitem', { name: /Sign out/ }));

    await screen.findByRole('button', { name: /Sign in/ });
    expect(screen.queryByRole('navigation', { name: /Main navigation/ })).toBeNull();
    await waitFor(() => expect(uiApp.app.container.session.isAuthenticated()).toBe(false));
  });
});
