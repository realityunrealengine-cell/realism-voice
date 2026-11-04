/// <reference types="vite/client" />
import type { RvBridge } from '../electron/shared';

declare global {
  interface Window {
    rv?: RvBridge;
  }
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
    readonly VITE_ENABLE_GOOGLE_AUTH?: string;
  }
}

export {};
