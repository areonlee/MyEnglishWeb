import fs from 'node:fs';
import path from 'node:path';

export function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function optionalEnv(name: string): string {
  return String(process.env[name] || '').trim();
}

export function hasCredentials(emailKey: string, passwordKey: string): boolean {
  return !!(optionalEnv(emailKey) && optionalEnv(passwordKey));
}

export function fixturePath(filename: string): string {
  return path.resolve(__dirname, '..', 'fixtures', filename);
}

export function resolveSubtitlePath(): string {
  const custom = optionalEnv('TEST_SUBTITLE_PATH');
  if (custom) {
    if (!fs.existsSync(custom)) throw new Error(`TEST_SUBTITLE_PATH not found: ${custom}`);
    return custom;
  }
  return fixturePath('sample.srt');
}

export function liveAsrEnabled(): boolean {
  return optionalEnv('TEST_RUN_LIVE_ASR') === '1';
}
