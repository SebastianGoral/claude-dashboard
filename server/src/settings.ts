import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DASH_DIR } from './files.js';

/** Settings of claude-dash, shared by the web app and the desktop app. */
export interface DashSettings {
  /** No sounds: no web sounds and silent desktop notifications. */
  muted: boolean;
  /** The app for a new session. */
  newSessionApp: 'terminal' | 'desktop';
  /** Folders the user hid from the "New session" list. */
  hiddenFolders: string[];
  /** Folders the user added to the "New session" list. */
  extraFolders: string[];
}

/** What the browser gets: the settings, plus facts the server knows. */
export interface SettingsView extends DashSettings {
  /** True while the desktop app is connected. Then it gives the alerts, and the browser stays silent. */
  desktopConnected: boolean;
  hooksInstalled: boolean;
}

const FILE = join(DASH_DIR, 'settings.json');
const DEFAULTS: DashSettings = { muted: false, newSessionApp: 'terminal', hiddenFolders: [], extraFolders: [] };

export interface SettingsStore {
  on(event: 'change', fn: (view: SettingsView) => void): this;
}

export class SettingsStore extends EventEmitter {
  private settings: DashSettings = { ...DEFAULTS };
  private desktopClients = 0;
  private hooks = false;

  async load(): Promise<void> {
    try {
      this.settings = { ...DEFAULTS, ...JSON.parse(await readFile(FILE, 'utf8')) };
    } catch {
      // No file yet: defaults.
    }
  }

  view(): SettingsView {
    return { ...this.settings, desktopConnected: this.desktopClients > 0, hooksInstalled: this.hooks };
  }

  async update(changes: Partial<DashSettings>): Promise<void> {
    if (typeof changes.muted === 'boolean') this.settings.muted = changes.muted;
    if (changes.newSessionApp === 'terminal' || changes.newSessionApp === 'desktop') this.settings.newSessionApp = changes.newSessionApp;
    await this.save();
  }

  /** Adds a folder to the "New session" list. A hidden folder shows again. */
  async addFolder(path: string): Promise<void> {
    const { extraFolders, hiddenFolders } = this.settings;
    this.settings.hiddenFolders = hiddenFolders.filter((p) => p !== path);
    if (!extraFolders.includes(path)) this.settings.extraFolders = [...extraFolders, path];
    await this.save();
  }

  async hideFolder(path: string): Promise<void> {
    const { extraFolders, hiddenFolders } = this.settings;
    this.settings.extraFolders = extraFolders.filter((p) => p !== path);
    if (!hiddenFolders.includes(path)) this.settings.hiddenFolders = [...hiddenFolders, path];
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(DASH_DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(this.settings, null, 2) + '\n');
    this.emit('change', this.view());
  }

  desktop(delta: 1 | -1): void {
    this.desktopClients += delta;
    this.emit('change', this.view());
  }

  setHooksInstalled(installed: boolean): void {
    if (installed === this.hooks) return;
    this.hooks = installed;
    this.emit('change', this.view());
  }
}
