/**
 * Everything the IPC layer needs from the *operating system* rather than from
 * the domain: opening files, picking paths, relaunching the app.
 *
 * The core services never touch Electron, which keeps them testable; the main
 * process implements this port, and the dev bridge substitutes a small stub so
 * the renderer can run in a plain browser during development.
 */

export interface FilePickerOptions {
  readonly title: string;
  readonly filters?: ReadonlyArray<{ name: string; extensions: string[] }>;
  readonly multi?: boolean;
  readonly defaultPath?: string;
}

export interface ThumbnailResult {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export interface MainPorts {
  /** Open a file/folder with the shell, optionally revealing it in Explorer. */
  openPath(path: string, reveal?: boolean): Promise<void>;
  openExternal(url: string): Promise<void>;
  relaunch(): void;
  quit(): void;
  pickFiles(options: FilePickerOptions): Promise<string[]>;
  pickFolder(title: string, defaultPath?: string): Promise<string | null>;
  hasOpenDialog(): boolean;
  thumbnail(path: string, maxPixels: number): Promise<ThumbnailResult | null>;
}
