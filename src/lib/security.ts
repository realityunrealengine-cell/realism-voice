// Двухфакторная аутентификация (Supabase Auth MFA, TOTP), резервные коды (Edge Function account-security)
// и активные сессии (функции базы my_sessions / revoke_session из миграции 0010).
import { supabase } from './supabase';
import { errorMessage, functionErrorMessage } from './errors';

export interface TotpEnrollment {
  factorId: string;
  qr: string; // data:image/svg+xml
  secret: string;
  uri: string;
}

export interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string | null;
  user_agent: string | null;
  ip: string | null;
  aal: string | null;
  is_current: boolean;
}

/** Сервер ещё не обновлён (нет функции или таблиц) */
export class ServerFeatureMissing extends Error {
  constructor(what: string) {
    super(`${what} станет доступно после обновления сервера (миграция 20261126000001_security.sql и функция account-security).`);
    this.name = 'ServerFeatureMissing';
  }
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('account-security', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx?.status === 404) throw new ServerFeatureMissing('Резервные коды');
    throw new Error(await functionErrorMessage(error));
  }
  return data as T;
}

export const security = {
  async factors() {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) throw new Error(errorMessage(error));
    return { verified: data.totp, all: data.all };
  },

  async enrollTotp(): Promise<TotpEnrollment> {
    // Незавершённые попытки подключения (фактор не подтверждён) мешают новой — убираем их
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const f of list?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => undefined);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Realism Voice ${new Date().toLocaleDateString('ru-RU')}` });
    if (error) throw new Error(errorMessage(error));
    return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  },

  /** Проверка кода (подтверждение фактора или вход): сессия становится aal2 */
  async verify(factorId: string, code: string) {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s+/g, '') });
    if (error) throw new Error(/invalid|expired/i.test(error.message) ? 'Неверный код. Проверьте время на компьютере и в телефоне.' : errorMessage(error));
  },

  async unenroll(factorId: string) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) throw new Error(errorMessage(error));
    await supabase.auth.refreshSession().catch(() => undefined);
  },

  async needsSecondFactor(): Promise<boolean> {
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return !!data && data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
  },

  recoveryStatus: () => invoke<{ remaining: number }>({ action: 'recovery_status' }),
  recoveryGenerate: () => invoke<{ codes: string[] }>({ action: 'recovery_generate' }),
  recoveryRedeem: (code: string) => invoke<{ ok: true }>({ action: 'recovery_redeem', code }),

  async sessions(): Promise<SessionRow[]> {
    const { data, error } = await supabase.rpc('my_sessions');
    if (error) {
      if (error.code === 'PGRST202' || /my_sessions/.test(error.message)) throw new ServerFeatureMissing('Список сессий');
      throw new Error(errorMessage(error));
    }
    return (data ?? []) as SessionRow[];
  },

  async revoke(id: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('revoke_session', { p_session: id });
    if (error) throw new Error(errorMessage(error));
    return data === true;
  },
};

export { AttemptLimiter } from './attemptLimiter';
