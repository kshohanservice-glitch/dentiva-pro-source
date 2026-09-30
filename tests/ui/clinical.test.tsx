/**
 * The dental chart, driven the way a dentist drives it: with the mouse and with
 * the keyboard. Findings are structured (type + surfaces + mobility + note) and
 * are written to the real chart table.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { todayIso } from '@shared/dates';
import { createPatient } from '../integration/harness';
import { createReadyUiApp, DEFAULT_PASSWORD, type UiApp } from './harness';

const apps: UiApp[] = [];

async function chartApp(): Promise<{ uiApp: UiApp; patientId: number }> {
  const uiApp = await createReadyUiApp({}, { signIn: false, render: false });
  apps.push(uiApp);
  // Registering a patient is a guarded action: it needs the signed-in owner.
  await uiApp.invoke('auth.login', { username: 'owner', password: DEFAULT_PASSWORD });
  const patient = createPatient(uiApp.app, { firstName: 'Chart', lastName: 'Patient', phone: '01711223344' });
  uiApp.renderApp(`/patients/${patient.id}`);
  await uiApp.user.click(await screen.findByRole('tab', { name: /Dental chart/ }));
  await screen.findByText('No findings recorded yet');
  return { uiApp, patientId: patient.id };
}

/** A tooth button in the chart (the visible code is the tooth's FDI code). */
function toothButton(code: string): HTMLButtonElement {
  const button = screen
    .getAllByRole('button')
    .find((candidate) => candidate.className.includes('tooth') && (candidate.textContent ?? '').startsWith(code));
  if (!button) throw new Error(`Tooth ${code} is not on the chart.`);
  return button as HTMLButtonElement;
}

afterEach(() => {
  while (apps.length > 0) apps.pop()?.dispose();
});

describe('dental chart', () => {
  it('records a finding with the mouse and stores it in the chart', async () => {
    const { uiApp, patientId } = await chartApp();

    // Adult chart, FDI numbering: the first molar is 16, as dentists expect.
    await uiApp.user.click(toothButton('16'));
    const panel = await screen.findByRole('heading', { name: /Tooth 16/ });
    const card = panel.closest('.card') as HTMLElement;
    await uiApp.user.click(within(card).getByRole('button', { name: 'Caries' }));
    await uiApp.user.click(within(card).getByRole('button', { name: /Save findings/ }));

    await waitFor(() => {
      const chart = uiApp.app.services.dental.getChart({ patientId });
      expect(chart.findings).toHaveLength(1);
      expect(chart.findings[0]).toMatchObject({ toothFdi: '16', finding: 'caries', isActive: true });
    });

    // The tooth is now marked on the chart itself.
    expect(toothButton('16').className).toContain('is-selected');
  });

  it('moves the selection with the keyboard alone', async () => {
    const { uiApp } = await chartApp();

    const first = toothButton('16');
    first.focus();
    expect(document.activeElement).toBe(first);
    await uiApp.user.keyboard('{ArrowRight}');

    // The arch reads 18 → 11 → 21 → 28, so the next tooth to the right of 16
    // is 15 (the neighbouring tooth in the patient's mouth).
    await waitFor(() => expect(screen.getByRole('heading', { name: /Tooth 15/ })).toBeTruthy());
    expect(toothButton('15').getAttribute('aria-pressed')).toBe('true');
    expect(toothButton('16').getAttribute('aria-pressed')).toBe('false');

    // ArrowDown jumps to the tooth in the same position in the lower arch.
    toothButton('15').focus();
    await uiApp.user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('heading', { name: /Tooth 45/ })).toBeTruthy());
  });

  it('switches between the adult and the primary dentition', async () => {
    const { uiApp } = await chartApp();
    const adult = toothButton('16');

    await uiApp.user.click(screen.getByRole('button', { name: 'Child (primary)' }));

    // Primary teeth use the 5-series codes, and the adult tooth is gone.
    await waitFor(() => expect(toothButton('55')).toBeTruthy());
    expect(screen.queryByRole('button', { name: adult.textContent ?? '16' })).toBeNull();
    expect(adult.isConnected).toBe(false);
  });

  it('keeps an immutable history of a tooth when a finding is cleared', async () => {
    const { uiApp, patientId } = await chartApp();
    await uiApp.user.click(toothButton('36'));
    const panel = await screen.findByRole('heading', { name: /Tooth 36/ });
    const card = panel.closest('.card') as HTMLElement;
    await uiApp.user.click(within(card).getByRole('button', { name: 'Caries' }));
    await uiApp.user.click(within(card).getByRole('button', { name: /Save findings/ }));
    await waitFor(() => expect(uiApp.app.services.dental.getChart({ patientId }).findings).toHaveLength(1));

    // Clearing the tooth deactivates the finding but never erases it.
    await uiApp.user.click(within(card).getByRole('button', { name: 'Caries' }));
    await uiApp.user.click(within(card).getByRole('button', { name: /Save findings/ }));

    await waitFor(() => expect(uiApp.app.services.dental.getChart({ patientId }).findings).toHaveLength(0));
    const history = uiApp.app.services.dental.history(patientId, '36');
    expect(history.length).toBeGreaterThan(0);
    expect(history.some((finding) => finding.isActive === false)).toBe(true);
  });
});

describe('prescription printing', () => {
  it('prints every clinical section with the dentist signature and credentials', async () => {
    const uiApp = await createReadyUiApp({}, { signIn: false, render: false });
    apps.push(uiApp);
    await uiApp.invoke('auth.login', { username: 'owner', password: DEFAULT_PASSWORD });
    const patient = createPatient(uiApp.app, { firstName: 'Ruma', lastName: 'Akter', phone: '01555667788' });
    const dentist = uiApp.app.services.dentists.list()[0]!;
    const prescription = uiApp.app.services.prescriptions.create({
      patientId: patient.id,
      dentistId: dentist.id,
      visitId: null,
      date: todayIso(),
      cc: ['Pain in the lower right molar'],
      oe: ['Deep caries on 46'],
      re: ['IOPA 46 shows radiolucency near the pulp'],
      advice: ['Warm saline rinse twice daily'],
      notes: '',
      items: [
        {
          medicationId: null,
          name: 'Amoxicillin',
          form: 'capsule',
          strength: '500 mg',
          doseMorning: 1,
          doseNoon: 0,
          doseNight: 1,
          foodTiming: 'after_food',
          durationDays: 5,
          quantity: 10,
          instructions: '',
          sortOrder: 1,
        },
      ],
    });

    uiApp.renderApp('/prescriptions');
    await uiApp.user.click(await screen.findByText(prescription.number));
    const dialog = await screen.findByRole('dialog', { name: new RegExp(`Prescription ${prescription.number}`) });
    await uiApp.user.click(within(dialog).getByRole('button', { name: /^PDF$/ }));

    await waitFor(() => expect(uiApp.app.printHost.jobs.length).toBeGreaterThan(0));
    const html = uiApp.app.printHost.lastHtml;
    // Clinic header and document identity.
    expect(html).toContain('Smile Dental Care');
    expect(html).toContain(prescription.number);
    expect(html).toContain('Ruma Akter');
    // The configured clinical sections and the medication line.
    for (const heading of ['C/C — Chief complaint', 'O/E — On examination', 'R/E — Radiographic evidence', 'Medications', 'Advice']) {
      expect(html).toContain(heading);
    }
    expect(html).toContain('Amoxicillin 500 mg');
    expect(html).toContain('after food');
    // The signature area carries the dentist and the qualifications they chose
    // to show on prescriptions.
    const signatureStart = html.indexOf('<div class="signature">');
    expect(signatureStart).toBeGreaterThan(-1);
    const signatureBlock = html.slice(signatureStart, html.indexOf('</div></div>', signatureStart));
    expect(signatureBlock).toContain('Dr. Ayesha Rahman');
    expect(signatureBlock).toContain('BDS');
  });
});
