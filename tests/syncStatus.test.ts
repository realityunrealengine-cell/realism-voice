import { describe, expect, it } from 'vitest';
import { deriveSync } from '@/lib/syncStatus';

const ok = { online: true, socketOk: true, presenceJoined: true, dataJoined: true };

describe('состояние синхронизации с сервером (отдельно от голоса)', () => {
  it('всё подключено — под ником обычная подпись', () => {
    expect(deriveSync(ok)).toEqual({ state: 'ok', label: null, detail: null });
  });

  it('случай Tvoiotec: канал статусов закрыт, голос работает — «Синхронизация…», а не «Нет соединения»', () => {
    const v = deriveSync({ ...ok, presenceJoined: false });
    expect(v.state).toBe('syncing');
    expect(v.label).toBe('Синхронизация…');
    expect(v.label).not.toMatch(/Нет соединения/);
    expect(v.detail).toMatch(/Статусы «в сети»/);
    expect(v.detail).toMatch(/Голосовая связь работает отдельно/);
  });

  it('канал сообщений не подписан — предупреждение о сообщениях', () => {
    expect(deriveSync({ ...ok, dataJoined: false }).detail).toMatch(/Новые сообщения/);
  });

  it('сокет не отвечает на heartbeat — синхронизация', () => {
    expect(deriveSync({ ...ok, socketOk: false }).state).toBe('syncing');
  });

  it('нет интернета важнее остальных признаков', () => {
    expect(deriveSync({ online: false, socketOk: false, presenceJoined: false, dataJoined: false }).label).toBe('Нет интернета');
  });

  it('после восстановления каналов подпись возвращается к обычной', () => {
    let v = deriveSync({ ...ok, presenceJoined: false, dataJoined: false });
    expect(v.state).toBe('syncing');
    v = deriveSync(ok);
    expect(v.state).toBe('ok');
  });
});
