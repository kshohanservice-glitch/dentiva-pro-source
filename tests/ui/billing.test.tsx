/**
 * Raising an invoice, collecting a payment and printing — the money path, driven
 * through the real UI, with every amount checked against the database in paisa.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createPatient } from '../integration/harness';
import { createReadyUiApp, DEFAULT_PASSWORD, type UiApp } from './harness';

const apps: UiApp[] = [];

/** The first treatment in the seeded catalogue (id, name and price in paisa). */
async function firstTreatment(uiApp: UiApp): Promise<{ id: number; name: string; pricePaisa: number }> {
  const list = await uiApp.invoke('resource.list', { resource: 'treatments', query: { page: 1, pageSize: 1 } });
  const item = list.items[0] as unknown as { id: number; name: string; pricePaisa: number };
  if (!item) throw new Error('The treatment catalogue is empty.');
  return item;
}

async function billingApp(): Promise<{ uiApp: UiApp; patientId: number }> {
  const uiApp = await createReadyUiApp({}, { signIn: false, render: false });
  apps.push(uiApp);
  await uiApp.invoke('auth.login', { username: 'owner', password: DEFAULT_PASSWORD });
  const patient = createPatient(uiApp.app, { firstName: 'Billing', lastName: 'Patient', phone: '01611223344' });
  uiApp.renderApp('/invoices');
  await screen.findByRole('heading', { name: 'Invoices' });
  return { uiApp, patientId: patient.id };
}

async function raiseInvoice(uiApp: UiApp, patientName: string, treatmentId: number): Promise<HTMLElement> {
  await uiApp.user.click(screen.getAllByRole('button', { name: /Raise invoice/ })[0]!);
  const dialog = await screen.findByRole('dialog', { name: /Raise an invoice/ });

  await uiApp.user.type(within(dialog).getByPlaceholderText(/Start typing a name, code or phone/), patientName);
  await uiApp.user.click(await within(dialog).findByRole('button', { name: new RegExp(patientName) }));

  const treatmentSelect = within(dialog)
    .getAllByRole('combobox')
    .find((select) => Array.from((select as HTMLSelectElement).options).some((option) => option.value === String(treatmentId)));
  if (!treatmentSelect) throw new Error(`Treatment ${treatmentId} is not offered in the invoice form.`);
  await uiApp.user.selectOptions(treatmentSelect as HTMLSelectElement, String(treatmentId));

  await uiApp.user.click(within(dialog).getByRole('button', { name: /^Raise invoice$/ }));
  // Saving opens the invoice detail, which is where payments and printing live.
  return screen.findByRole('dialog', { name: /Invoice INV-\d{4}-\d{6}/ });
}

afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

describe('invoices', () => {
  it('raises an invoice from the catalogue and stores the exact amounts', async () => {
    const { uiApp, patientId } = await billingApp();
    const treatment = await firstTreatment(uiApp);

    const detailDialog = await raiseInvoice(uiApp, 'Billing Patient', treatment.id);

    // The invoice was created with a real number and the catalogue price…
    const invoice = uiApp.app.services.invoices.list({ page: 1, pageSize: 10 }).items[0]!;
    const detail = uiApp.app.services.invoices.get(invoice.id);
    expect(detail.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(detail.patientId).toBe(patientId);
    expect(detail.subtotalPaisa).toBe(treatment.pricePaisa);
    expect(detail.totalPaisa).toBe(treatment.pricePaisa);
    expect(detail.duePaisa).toBe(treatment.pricePaisa);
    expect(detail.status).toBe('unpaid');
    // …and the screen shows the same amount as the database holds.
    expect(detailDialog.textContent).toContain(detail.number);
    expect(within(detailDialog).getAllByText('৳12,000').length).toBeGreaterThan(0);
  });

  it('collects a payment and reconciles the balance', async () => {
    const { uiApp } = await billingApp();
    const treatment = await firstTreatment(uiApp);
    const detail = await raiseInvoice(uiApp, 'Billing Patient', treatment.id);
    await uiApp.user.click(within(detail).getByRole('button', { name: /Take payment/ }));

    const payDialog = await screen.findByRole('dialog', { name: /Take payment/ });
    // The field opens on the full outstanding amount; a part payment replaces it.
    const amountField = within(payDialog).getByLabelText(/Amount received/);
    await uiApp.user.clear(amountField);
    await uiApp.user.type(amountField, '500');
    const method = within(payDialog)
      .getAllByRole('combobox')
      .find((select) => Array.from((select as HTMLSelectElement).options).some((option) => option.textContent === 'Cash'))!;
    const cash = Array.from((method as HTMLSelectElement).options).find((option) => option.textContent === 'Cash')!;
    await uiApp.user.selectOptions(method as HTMLSelectElement, cash.value);
    await uiApp.user.click(within(payDialog).getByRole('button', { name: /Record payment/ }));

    const invoice = uiApp.app.services.invoices.list({ page: 1, pageSize: 10 }).items[0]!;
    await waitFor(() => {
      const stored = uiApp.app.services.invoices.get(invoice.id);
      expect(stored.paidPaisa).toBe(50_000);
      expect(stored.duePaisa).toBe(treatment.pricePaisa - 50_000);
      expect(stored.status).toBe('partially_paid');
    });
    const payments = uiApp.app.services.payments.list({ page: 1, pageSize: 10 });
    expect(payments.total).toBe(1);
    expect(payments.items[0]?.amountPaisa).toBe(50_000);
  });

  it('refuses a payment larger than the outstanding balance', async () => {
    const { uiApp } = await billingApp();
    const treatment = await firstTreatment(uiApp);
    const detail = await raiseInvoice(uiApp, 'Billing Patient', treatment.id);
    await uiApp.user.click(within(detail).getByRole('button', { name: /Take payment/ }));

    const payDialog = await screen.findByRole('dialog', { name: /Take payment/ });
    const amountField = within(payDialog).getByLabelText(/Amount received/);
    await uiApp.user.clear(amountField);
    await uiApp.user.type(amountField, '99999');
    const method = within(payDialog)
      .getAllByRole('combobox')
      .find((select) => Array.from((select as HTMLSelectElement).options).some((option) => option.textContent === 'Cash'))!;
    const cash = Array.from((method as HTMLSelectElement).options).find((option) => option.textContent === 'Cash')!;
    await uiApp.user.selectOptions(method as HTMLSelectElement, cash.value);
    await uiApp.user.click(within(payDialog).getByRole('button', { name: /Record payment/ }));

    // The core refuses it and says why; nothing is written.
    await screen.findByText(/The payment could not be recorded/);
    expect(uiApp.app.services.payments.list({ page: 1, pageSize: 5 }).total).toBe(0);
  });

  it('prints the invoice with the clinic header and no doctor signature', async () => {
    const { uiApp } = await billingApp();
    const treatment = await firstTreatment(uiApp);
    const detail = await raiseInvoice(uiApp, 'Billing Patient', treatment.id);
    await uiApp.user.click(within(detail).getByRole('button', { name: /^PDF$/ }));

    await waitFor(() => expect(uiApp.app.printHost.jobs.length).toBeGreaterThan(0));
    const html = uiApp.app.printHost.lastHtml;
    const invoice = uiApp.app.services.invoices.list({ page: 1, pageSize: 10 }).items[0]!;
    expect(html).toContain('Smile Dental Care');
    expect(html).toContain(invoice.number);
    expect(html).toContain(treatment.name);
    // An invoice is a financial document: the clinic header only, never a
    // doctor's signature block (prescriptions are the signed document).
    expect(html).not.toContain('<div class="signature">');
    expect(html).toContain('Total');
  });
});
