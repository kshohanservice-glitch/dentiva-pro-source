/**
 * Desktop implementation of `MainPorts`.
 *
 * Everything the renderer is *not* allowed to do directly — dialogs, opening
 * files, revealing a folder, external links — goes through here. External links
 * are restricted to http/https, and a file dialog suspends the idle clock so a
 * receptionist reading a long dialog is never locked out mid-task.
 */
import { BrowserWindow, app, dialog, nativeImage, shell } from 'electron';
import { AppError } from '@shared/errors';
import type { MainPorts } from './ipc/handlers';

export interface ElectronPortsOptions {
  window(): BrowserWindow | null;
  /** Called with `true` while a modal dialog is open (the idle clock pauses). */
  onDialog?(open: boolean): void;
}

export function createElectronPorts(options: ElectronPortsOptions): MainPorts {
  let dialogOpen = false;

  function setDialog(open: boolean): void {
    dialogOpen = open;
    options.onDialog?.(open);
  }

  return {
    async openPath(path, reveal) {
      if (!path) throw AppError.validation('No file was given.');
      if (reveal) {
        shell.showItemInFolder(path);
        return;
      }
      const error = await shell.openPath(path);
      if (error) throw new AppError('IO', `The file could not be opened: ${error}`);
    },

    async openExternal(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw AppError.validation('That link is not a valid address.');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw AppError.validation('Only web links can be opened.');
      }
      await shell.openExternal(parsed.toString());
    },

    relaunch() {
      app.relaunch();
      app.exit(0);
    },

    quit() {
      app.quit();
    },

    async pickFiles(input) {
      setDialog(true);
      try {
        const window = options.window();
        const result = await dialog.showOpenDialog(window ?? undefined!, {
          title: input.title,
          properties: input.multi ? ['openFile', 'multiSelections'] : ['openFile'],
          filters: input.filters ? input.filters.map((filter) => ({ ...filter })) : undefined,
        });
        return result.canceled ? [] : result.filePaths;
      } finally {
        setDialog(false);
      }
    },

    async pickFolder(title) {
      setDialog(true);
      try {
        const window = options.window();
        const result = await dialog.showOpenDialog(window ?? undefined!, {
          title,
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      } finally {
        setDialog(false);
      }
    },

    hasOpenDialog() {
      return dialogOpen;
    },

    async thumbnail(path, maxPixels) {
      const limit = Math.min(2048, Math.max(32, Math.round(maxPixels)));
      const image = nativeImage.createFromPath(path);
      if (image.isEmpty()) return null;
      const size = image.getSize();
      const scale = Math.min(1, limit / Math.max(size.width, size.height));
      const resized = scale < 1 ? image.resize({ width: Math.round(size.width * scale) }) : image;
      const finalSize = resized.getSize();
      return {
        dataUrl: resized.toDataURL(),
        width: finalSize.width,
        height: finalSize.height,
      };
    },
  };
}
