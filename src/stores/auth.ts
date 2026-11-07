import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import { AUTH_CALLBACK_URL, AUTH_RESET_URL, supabase } from '@/lib/supabase';
import { errorMessage, toAppError } from '@/lib/errors';
import type { Profile } from '@/lib/types';
import type { DeepLink } from '../../electron/shared';
import { useProfiles } from './profiles';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'recovery' | 'dbMissing';

interface AuthState {
  status: AuthStatus;
  session: Session | null;
  userId: string | null;
  profile: Profile | null;
  notice: string | null;
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, username: string, displayName: string) => Promise<'confirm' | 'signedIn'>;
  verifyOtp: (email: string, token: string, type: 'signup' | 'recovery') => Promise<void>;
  resendConfirmation: (email: string) => Promise<void>;
  sendReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  handleAuthLink: (link: Extract<DeepLink, { type: 'auth' }>) => Promise<void>;
  loadProfile: () => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => Promise<void>;
  setNotice: (n: string | null) => void;
}

let initialized = false;

/** Действия перед выходом из аккаунта (пока токен ещё действителен): уход из голоса, снятие присутствия */
const beforeSignOut: (() => Promise<void>)[] = [];
export function onBeforeSignOut(fn: () => Promise<void>) {
  beforeSignOut.push(fn);
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  session: null,
  userId: null,
  profile: null,
  notice: null,

  init: async () => {
    if (initialized) return;
    initialized = true;
    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        set({ session, userId: session?.user.id ?? null, status: 'recovery' });
        return;
      }
      if (event === 'SIGNED_OUT' || !session) {
        set({ session: null, userId: null, profile: null, status: 'signedOut' });
        return;
      }
      const prevUser = get().userId;
      set({ session, userId: session.user.id });
      if (event === 'SIGNED_IN' && prevUser !== session.user.id && get().status !== 'recovery') {
        // Supabase рекомендует не вызывать API синхронно внутри колбэка
        setTimeout(() => void get().loadProfile(), 0);
      }
    });
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      set({ session: data.session, userId: data.session.user.id });
      await get().loadProfile();
    } else {
      set({ status: 'signedOut' });
    }
  },

  loadProfile: async () => {
    const uid = get().userId;
    if (!uid) return;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (error) {
      if (error.code === 'PGRST205' || error.code === '42P01') {
        set({ status: 'dbMissing' });
        return;
      }
      // Сеть недоступна — показываем приложение, данные подтянутся позже
      set({ status: 'signedIn', notice: errorMessage(error) });
      return;
    }
    if (!data) {
      set({ status: 'dbMissing' });
      return;
    }
    useProfiles.getState().upsert([data as Profile]);
    set({ profile: data as Profile, status: get().status === 'recovery' ? 'recovery' : 'signedIn' });
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw toAppError(error);
  },

  signUp: async (email, password, username, displayName) => {
    const { data: available, error: availErr } = await supabase.rpc('username_available', { p_username: username });
    if (availErr) throw new Error(errorMessage(availErr));
    if (!available) throw new Error('Этот username уже занят');
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: AUTH_CALLBACK_URL,
        data: { username: username.toLowerCase(), display_name: displayName.trim() },
      },
    });
    if (error) throw toAppError(error);
    // Если в проекте включено подтверждение email, сессии ещё нет
    if (!data.session) {
      // Supabase не раскрывает, существует ли уже такой email: identities будет пустым
      if (data.user && data.user.identities && data.user.identities.length === 0) {
        throw new Error('Пользователь с таким email уже зарегистрирован');
      }
      return 'confirm';
    }
    return 'signedIn';
  },

  verifyOtp: async (email, token, type) => {
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: token.trim(), type });
    if (error) throw new Error(errorMessage(error));
    if (type === 'recovery') set({ status: 'recovery' });
  },

  resendConfirmation: async (email) => {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: AUTH_CALLBACK_URL },
    });
    if (error) throw toAppError(error);
  },

  sendReset: async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: AUTH_RESET_URL });
    if (error) throw new Error(errorMessage(error));
  },

  updatePassword: async (password) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(errorMessage(error));
    if (get().status === 'recovery') {
      set({ status: 'loading' });
      await get().loadProfile();
    }
  },

  signInWithGoogle: async () => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error) throw new Error(errorMessage(error));
    if (data.url) await window.rv?.app.openExternal(data.url);
  },

  signOut: async () => {
    await Promise.allSettled(beforeSignOut.map((fn) => fn()));
    await supabase.auth.signOut();
    set({ session: null, userId: null, profile: null, status: 'signedOut' });
  },

  handleAuthLink: async (link) => {
    if (link.error) {
      set({
        notice:
          link.error === 'otp_expired'
            ? 'Ссылка из письма устарела. Запросите новое письмо.'
            : link.errorDescription ?? 'Не удалось подтвердить ссылку',
      });
      return;
    }
    if (!link.code) return;
    const isReset = link.action === 'reset';
    if (isReset) set({ status: 'recovery' });
    const { error } = await supabase.auth.exchangeCodeForSession(link.code);
    if (error) {
      set({
        status: get().session ? get().status : 'signedOut',
        notice: isReset
          ? 'Ссылка для сброса пароля недействительна. Запросите новую.'
          : 'Email подтверждён. Войдите, используя свой пароль.',
      });
      return;
    }
    if (!isReset) {
      set({ notice: null });
      await get().loadProfile();
    }
  },

  updateProfile: async (patch) => {
    const uid = get().userId;
    if (!uid) return;
    const { data, error } = await supabase.from('profiles').update(patch).eq('id', uid).select('*').single();
    if (error) throw new Error(errorMessage(error));
    useProfiles.getState().upsert([data as Profile]);
    set({ profile: data as Profile });
  },

  setNotice: (notice) => set({ notice }),
}));
