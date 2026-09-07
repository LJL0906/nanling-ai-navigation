import type { getRuntimeSettings } from './server/settings-store';

declare global {
  namespace App {
    interface Locals {
      getRuntimeSettings: typeof getRuntimeSettings;
    }
  }
}

export {};
