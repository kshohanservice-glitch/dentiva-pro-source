/**
 * Printer and PDF adapter.
 *
 * Every document is produced by a hidden `BrowserWindow` that renders the very
 * same HTML the services generate, so the on-screen preview, the PDF and the
 * paper copy are byte-for-byte the same layout. The window is off-screen, has
 * no preload script and is destroyed as soon as the job finishes, which keeps
 * a print job invisible and short-lived.
 */
import { app, BrowserWindow, shell } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrintHostPort, PrintRenderOptions } from '@core/services/print-service';
import type { SystemPrinter } from '@shared/types';
import { AppError } from '@shared/errors';

/** Micrometres per millimetre — Electron sizes pages in microns. */
const MICRON = 1000;

export class ElectronPrintHost implements PrintHostPort {
  private counter = 0;

  constructor(private readonly tempDir: string) {
    mkdirSync(tempDir, { recursive: true });
  }

  async listPrinters(): Promise<SystemPrinter[]> {
    const window = this.createWindow();
    try {
      const printers = await window.webContents.getPrintersAsync();
      return printers
        .map((printer) => {
          const options = Object.fromEntries(
            Object.entries(printer.options ?? {}).map(([key, value]) => [key, String(value)]),
          );
          return {
            name: printer.name,
            displayName: printer.displayName || printer.name,
            description: printer.description ?? '',
            status: Number(options['printer-state'] ?? 0) || 0,
            isDefault: options['printer-is-default'] === 'true',
            options,
          };
        })
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName));
    } catch (error) {
      throw new AppError('PRINT_FAILED', `The printer list could not be read: ${(error as Error).message}`);
    } finally {
      window.destroy();
    }
  }

  async toPdf(html: string, options: PrintRenderOptions): Promise<{ path: string; pageCount: number; bytes: number }> {
    const window = this.createWindow();
    try {
      await this.load(window, html);
      const buffer = await window.webContents.printToPDF({
        printBackground: true,
        landscape: options.orientation === 'landscape',
        preferCSSPageSize: true,
        scale: clampScale(options.scalePercent),
        pageSize: {
          width: Math.round(options.widthMm * MICRON),
          height: Math.round(options.heightMm * MICRON),
        },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      const path = join(this.tempDir, `print-${Date.now()}-${(this.counter += 1)}.pdf`);
      writeFileSync(path, buffer);
      const pages = countPdfPages(buffer) || (await this.measurePages(window, options));
      return { path, pageCount: pages, bytes: buffer.byteLength };
    } catch (error) {
      throw new AppError('PRINT_FAILED', `The PDF could not be generated: ${(error as Error).message}`);
    } finally {
      window.destroy();
    }
  }

  async send(html: string, options: PrintRenderOptions): Promise<{ pageCount: number; bytes: number }> {
    const window = this.createWindow();
    try {
      await this.load(window, html);
      const pageCount = await this.measurePages(window, options);
      const bytes = Buffer.byteLength(html, 'utf8');
      const sent = await new Promise<boolean>((resolve, reject) => {
        window.webContents.print(
          {
            silent: true,
            printBackground: true,
            copies: Math.max(1, options.copies),
            deviceName: options.printerName || undefined,
            scaleFactor: clampScale(options.scalePercent),
            landscape: options.orientation === 'landscape',
            margins: {
              marginType: 'custom',
              top: options.marginTopMm / 25.4,
              bottom: options.marginBottomMm / 25.4,
              left: options.marginLeftMm / 25.4,
              right: options.marginRightMm / 25.4,
            },
            pageSize: {
              width: Math.round(options.widthMm * MICRON),
              height: Math.round(options.heightMm * MICRON),
            },
          },
          (success, reason) => (success ? resolve(true) : reject(new AppError('PRINT_FAILED', reason || 'The printer rejected the job.'))),
        );
      });
      if (!sent) throw new AppError('PRINT_FAILED', 'The printer rejected the job.');
      return { pageCount, bytes };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('PRINT_FAILED', `The document could not be printed: ${(error as Error).message}`);
    } finally {
      window.destroy();
    }
  }

  async reveal(path: string): Promise<void> {
    shell.showItemInFolder(path);
  }

  // -- internals -----------------------------------------------------------

  private createWindow(): BrowserWindow {
    return new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: {
        offscreen: false,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
  }

  private async load(window: BrowserWindow, html: string): Promise<void> {
    const url = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
    await window.loadURL(url);
    // Images, fonts and stylesheets are all inline, so this only waits for the
    // font faces to finish decoding before the first page is measured.
    await window.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true);
  }

  /** How many pages the document occupies, used for printer jobs (no PDF). */
  private async measurePages(window: BrowserWindow, options: PrintRenderOptions): Promise<number> {
    const usableMm = Math.max(20, options.heightMm - options.marginTopMm - options.marginBottomMm);
    const usablePx = (usableMm * 96) / 25.4 / clampScale(options.scalePercent);
    try {
      const height = (await window.webContents.executeJavaScript(
        'document.body ? document.body.scrollHeight : 0',
        true,
      )) as number;
      if (!Number.isFinite(height) || height <= 0) return 1;
      return Math.max(1, Math.ceil(height / Math.max(1, usablePx)));
    } catch {
      return 1;
    }
  }
}

function clampScale(percent: number): number {
  const scale = Number.isFinite(percent) ? percent / 100 : 1;
  return Math.min(2, Math.max(0.5, scale));
}

/** Cheap page count for a PDF buffer produced by Chromium. */
export function countPdfPages(buffer: Buffer): number {
  const text = buffer.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

export function appTempDir(): string {
  return join(app.getPath('temp'), 'dentiva-pro');
}
