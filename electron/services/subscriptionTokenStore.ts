/**
 * Encrypted-at-rest storage for the Google subscription OAuth token bundle.
 *
 * Primary: Electron's safeStorage (OS keyring - DPAPI on Windows, Keychain on
 * macOS, Secret Service on Linux). Fallback: AES-256-GCM with a key derived
 * from machine-identifying material, so tokens are at least not plaintext if
 * the OS keyring is unavailable. The fallback is weaker by design and logs a
 * warning when used.
 */

import { app, safeStorage } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SubscriptionTokenStore, SubscriptionTokens } from './GeminiSubscriptionService';

const STORE_FILE = 'subscription-tokens.bin';

function storePath(): string {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function fallbackKey(): Buffer {
  const machineId = `${os.hostname()}|${os.userInfo().username}|phantomlens-subscription`;
  return crypto.scryptSync(machineId, 'phantomlens-subscription-salt', 32);
}

function encryptFallback(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fallbackKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // version byte 0x01 = AES-GCM fallback
  return Buffer.concat([Buffer.from([0x01]), iv, tag, ciphertext]);
}

function decryptFallback(blob: Buffer): string {
  if (blob[0] !== 0x01) throw new Error('Unknown token blob version.');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const ciphertext = blob.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', fallbackKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function encryptTokens(tokens: SubscriptionTokens): Buffer {
  const plaintext = JSON.stringify(tokens);
  if (safeStorage.isEncryptionAvailable()) {
    // version byte 0x02 = safeStorage
    return Buffer.concat([Buffer.from([0x02]), safeStorage.encryptString(plaintext)]);
  }
  console.warn(
    '[subscription] OS keyring unavailable - OAuth tokens are encrypted with a machine-derived fallback key instead.'
  );
  return encryptFallback(plaintext);
}

function decryptTokens(blob: Buffer): SubscriptionTokens {
  const version = blob[0];
  const payload = blob.subarray(1);
  let plaintext: string;
  if (version === 0x02) {
    plaintext = safeStorage.decryptString(payload);
  } else if (version === 0x01) {
    plaintext = decryptFallback(blob);
  } else {
    throw new Error('Unknown token blob version.');
  }
  const parsed = JSON.parse(plaintext) as Partial<SubscriptionTokens>;
  if (
    typeof parsed.accessToken !== 'string' ||
    typeof parsed.refreshToken !== 'string' ||
    typeof parsed.expiresAt !== 'number' ||
    typeof parsed.projectId !== 'string'
  ) {
    throw new Error('Token blob failed validation.');
  }
  return parsed as SubscriptionTokens;
}

function writeFileAtomic(filePath: string, data: Buffer): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, data, { mode: 0o600 });
    try {
      fs.renameSync(tempPath, filePath);
    } catch {
      // Windows: rename over an existing file can fail; copy + delete instead.
      fs.copyFileSync(tempPath, filePath);
      fs.unlinkSync(tempPath);
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* best effort on Windows */
    }
    return true;
  } catch (error) {
    console.error('[subscription] Failed to write token store:', error);
    return false;
  }
}

class SafeStorageTokenStore implements SubscriptionTokenStore {
  loadTokens(): SubscriptionTokens | null {
    try {
      const filePath = storePath();
      if (!fs.existsSync(filePath)) return null;
      return decryptTokens(fs.readFileSync(filePath));
    } catch (error) {
      console.error('[subscription] Failed to load tokens:', error);
      return null;
    }
  }

  saveTokens(tokens: SubscriptionTokens): boolean {
    try {
      return writeFileAtomic(storePath(), encryptTokens(tokens));
    } catch (error) {
      console.error('[subscription] Failed to save tokens:', error);
      return false;
    }
  }

  clearTokens(): boolean {
    try {
      const filePath = storePath();
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      console.error('[subscription] Failed to clear tokens:', error);
      return false;
    }
  }
}

export const subscriptionTokenStore: SubscriptionTokenStore = new SafeStorageTokenStore();
