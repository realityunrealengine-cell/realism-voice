import { describe, expect, it } from 'vitest';
import { AppError, errorMessage, toAppError } from '@/lib/errors';

describe('ошибки регистрации и входа', () => {
  it('лимит писем Supabase: понятное объяснение, что аккаунт не создан', () => {
    const e = toAppError({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded', status: 429 });
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('over_email_send_rate_limit');
    expect(e.message).toMatch(/Аккаунт не создан/);
    expect(e.message).not.toMatch(/^Слишком много писем/);
  });

  it('лимит писем распознаётся и без кода (старые версии сервера)', () => {
    expect(toAppError({ message: 'email rate limit exceeded' }).code).toBe('over_email_send_rate_limit');
    expect(errorMessage({ message: 'email rate limit exceeded' })).toMatch(/лимит писем/);
  });

  it('прочие лимиты запросов не путаются с почтовым', () => {
    expect(errorMessage({ message: 'Request rate limit reached' })).toBe('Слишком много попыток. Подождите немного.');
  });

  it('неподтверждённый email: код сохраняется, чтобы интерфейс открыл подтверждение', () => {
    expect(toAppError({ code: 'email_not_confirmed', message: 'Email not confirmed' }).code).toBe('email_not_confirmed');
    expect(toAppError({ message: 'Email not confirmed' }).code).toBe('email_not_confirmed');
  });

  it('адрес не разрешён встроенной почтой Supabase', () => {
    expect(errorMessage({ code: 'email_address_not_authorized' })).toMatch(/администратору/);
  });
});
