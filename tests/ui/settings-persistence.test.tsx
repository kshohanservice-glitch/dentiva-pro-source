/** Settings must not discard unsaved edits after an IPC error. */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bridge } from '@renderer/lib/bridge';
import { createReadyUiApp, type UiApp } from './harness';

const apps: UiApp[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (apps.length) apps.pop()?.dispose();
});

describe('settings save and reload', () => {
  it('keeps edits after a failed save, then persists them across a screen remount', async () => {
    const ui = await createReadyUiApp({}, { route: '/settings' });
    apps.push(ui);
    await ui.user.click(await screen.findByRole('tab', { name: /Appearance & formats/ }));
    await ui.user.click(screen.getByRole('button', { name: 'Compact' }));
    const save = screen.getByRole('button', { name: /Save 1 change/ });

    const spy = vi.spyOn(bridge, 'invoke').mockRejectedValueOnce(Object.assign(new Error('Disk write refused'), { code: 'IO' }));
    await ui.user.click(save);
    await waitFor(() => expect(screen.getByRole('button', { name: /Save 1 change/ })).toBeTruthy());
    expect((await ui.invoke('settings.get')).density).toBe('comfortable');
    spy.mockRestore();

    await ui.user.click(screen.getByRole('button', { name: /Save 1 change/ }));
    await waitFor(async () => expect((await ui.invoke('settings.get')).density).toBe('compact'));
    await ui.user.click(screen.getByRole('tab', { name: 'Clinic' }));
    await ui.user.click(screen.getByRole('tab', { name: /Appearance & formats/ }));
    expect(screen.getByRole('button', { name: 'Compact' }).getAttribute('aria-pressed')).toBe('true');
  });
});
