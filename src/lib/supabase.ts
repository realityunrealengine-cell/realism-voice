import { createClient, type SupportedStorage } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const SUPABASE_URL = url ?? '';
export const configError =
  !url || !key
    ? 'Не заданы VITE_SUPABASE_URL и VITE_SUPABASE_PUBLISHABLE_KEY. Создайте файл .env.local по образцу .env.example и пересоберите приложение.'
    : null;

export const AUTH_CALLBACK_URL = 'realismvoice://auth/callback';
export const AUTH_RESET_URL = 'realismvoice://auth/reset';
export const GOOGLE_AUTH_ENABLED = import.meta.env.VITE_ENABLE_GOOGLE_AUTH === 'true';

// Сессия хранится в main-процессе в зашифрованном виде (safeStorage / DPAPI).
// В обычном браузере (только для отладки вёрстки) — sessionStorage.
const secureStorage: SupportedStorage = window.rv
  ? {
      getItem: (k) => window.rv!.storage.getItem(k),
      setItem: (k, v) => window.rv!.storage.setItem(k, v),
      removeItem: (k) => window.rv!.storage.removeItem(k),
    }
  : window.sessionStorage;

export const supabase = createClient(url || 'https://invalid.supabase.co', key || 'invalid', {
  auth: {
    flowType: 'pkce',
    storage: secureStorage,
    storageKey: 'sb-rv-auth',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
  realtime: {
    params: { eventsPerSecond: 20 },
  },
});

export function publicUrl(bucket: 'avatars' | 'server-icons' | 'profile-banners', path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
