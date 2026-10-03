// StealthKeyboardManager.ts
//
// Main-process owner of the stealth keyboard hook (native/stealth-keyboard).
// When a typing session starts, a WH_KEYBOARD_LL hook captures keystrokes
// OS-wide and swallows them, forwarding characters to the renderer via the
// "stealth-key" channel. The PhantomLens window never takes focus, so the
// foreground app is undisturbed - the "natively" stealth-typing approach.
//
// If the native module is missing or fails to load (non-Windows, AV removed
// it, ...), start() returns false and the caller falls back to the classic
// focus-based typing.

import { BrowserWindow } from "electron";
import * as path from "path";
import * as fs from "fs";

export interface StealthKeyEvent {
  kind: "char" | "backspace" | "enter" | "escape";
  char?: string;
}

interface StealthKeyboardAddon {
  startTyping(cb: (ev: StealthKeyEvent) => void): boolean;
  stopTyping(): boolean;
}

const ADDON_REL_PATH = path.join(
  "native",
  "stealth-keyboard",
  "prebuilt",
  "win32-x64",
  "stealth_keyboard.node"
);

export class StealthKeyboardManager {
  private addon: StealthKeyboardAddon | null = null;
  private loadAttempted = false;
  private active = false;

  constructor(private getMainWindow: () => BrowserWindow | null) {}

  private resolveAddonPath(): string | null {
    const candidates = [
      // Packaged app: electron-builder unpacks *.node next to the asar.
      path.join(process.resourcesPath, "app.asar.unpacked", ADDON_REL_PATH),
      // Dev (npm run dev / electron .): repo root relative to dist-electron.
      path.join(__dirname, "..", "..", ADDON_REL_PATH),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch {
        // ignore
      }
    }
    return null;
  }

  private loadAddon(): boolean {
    if (this.addon) return true;
    if (this.loadAttempted) return false;
    this.loadAttempted = true;
    if (process.platform !== "win32") {
      console.log("[StealthKeyboard] Not on Windows - stealth typing unavailable");
      return false;
    }
    const addonPath = this.resolveAddonPath();
    if (!addonPath) {
      console.warn("[StealthKeyboard] Native module not found - stealth typing unavailable");
      return false;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.addon = require(addonPath) as StealthKeyboardAddon;
      console.log("[StealthKeyboard] Native module loaded from", addonPath);
      return true;
    } catch (error) {
      console.error("[StealthKeyboard] Failed to load native module:", error);
      this.addon = null;
      return false;
    }
  }

  /** True when the native hook is usable on this machine. */
  isAvailable(): boolean {
    return this.loadAddon();
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Begin a stealth typing session. Returns true when the hook is live and
   * keystrokes will arrive on the "stealth-key" channel; false when the
   * caller should fall back to focus-based typing.
   */
  start(): boolean {
    if (this.active) return true;
    if (!this.loadAddon() || !this.addon) return false;
    try {
      const ok = this.addon.startTyping((ev: StealthKeyEvent) => {
        const w = this.getMainWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send("stealth-key", ev);
        }
      });
      if (ok) {
        this.active = true;
        console.log("[StealthKeyboard] Typing session started");
        return true;
      }
    } catch (error) {
      console.error("[StealthKeyboard] startTyping failed:", error);
    }
    return false;
  }

  /** End the typing session; keys flow normally again. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    try {
      this.addon?.stopTyping();
    } catch (error) {
      console.error("[StealthKeyboard] stopTyping failed:", error);
    }
    console.log("[StealthKeyboard] Typing session stopped");
  }
}
