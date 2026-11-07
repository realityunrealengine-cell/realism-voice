// Состояние связи с сервером Realism Voice (Supabase Realtime) — ОТДЕЛЬНО от голосовой связи (LiveKit).
//
// Ошибка версий 1.0.x: под ником в нижней панели показывалось «Нет соединения…», когда закрывался
// Realtime-канал статусов (presence:global). Голос при этом работал через LiveKit, а надпись
// внушала, что связь потеряна. Канал к тому же не восстанавливался: пользователь видел себя «в сети»
// по устаревшей локальной копии, а для остальных сервер его уже удалил — он был «Не в сети».
//
// Теперь состояние синхронизации считается из независимых признаков и называется честно:
// «Нет интернета» или «Синхронизация…» (статусы и новые сообщения могут запаздывать), а голос
// показывается своим индикатором.

export type SyncState = 'ok' | 'syncing' | 'offline';

export interface SyncInputs {
  /** Windows сообщает о наличии сети */
  online: boolean;
  /** WebSocket Realtime отвечает на heartbeat */
  socketOk: boolean;
  /** Канал статусов (presence:global) подписан */
  presenceJoined: boolean;
  /** Канал изменений базы (сообщения, серверы, друзья) подписан */
  dataJoined: boolean;
}

export interface SyncView {
  state: SyncState;
  /** Короткая подпись под ником (null — всё в порядке) */
  label: string | null;
  /** Подробное объяснение для подсказки */
  detail: string | null;
}

export function deriveSync(i: SyncInputs): SyncView {
  if (!i.online) {
    return {
      state: 'offline',
      label: 'Нет интернета',
      detail: 'Windows сообщает, что подключения к интернету нет. Всё восстановится автоматически, когда сеть появится.',
    };
  }
  if (!i.socketOk || !i.presenceJoined || !i.dataJoined) {
    const what = !i.dataJoined && i.presenceJoined ? 'Новые сообщения' : !i.presenceJoined && i.dataJoined ? 'Статусы «в сети»' : 'Статусы и новые сообщения';
    return {
      state: 'syncing',
      label: 'Синхронизация…',
      detail: `${what} могут обновляться с задержкой — соединение с сервером восстанавливается автоматически. Голосовая связь работает отдельно и этим не затронута. Нажмите, чтобы переподключиться сейчас.`,
    };
  }
  return { state: 'ok', label: null, detail: null };
}
