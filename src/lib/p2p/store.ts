// Локальное хранилище P2P-сообщений (IndexedDB в профиле приложения).
//
// P2P-сообщения не попадают на сервер, поэтому их история хранится на устройствах собеседников:
//   * messages — сами сообщения (с версией для синхронизации правок и удалений);
//   * outbox   — очередь неподтверждённых операций (сообщение, правка, удаление, реакция): переживает
//                перезапуск приложения и отправляется, когда получатель снова доступен;
//   * seen     — идентификаторы принятых операций (защита от дублей), хранятся 30 дней.
// Запись пакетная: изменения копятся в памяти и пишутся одной транзакцией (раз в ~300 мс) —
// меньше обращений к диску, чем запись каждой операции отдельно.
// С 1.3.1 сообщения и очередь лежат на диске зашифрованными (AES-256-GCM, ключ под Windows DPAPI, см. vault.ts);
// открытыми остаются только служебные поля для индексов (id, владелец, переписка). Записи 1.3.0 без шифрования
// перешифровываются при первом чтении.
import type { Message } from '@/lib/types';
import { openJson, sealJson, vaultKey } from './vault';

export type OpKind = 'msg' | 'edit' | 'del' | 'react';

export interface StoredMessage {
  id: string;
  owner: string;
  dm_id: string;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  kind: 'default';
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reactions: Record<string, string[]>;
  /** Версия (мс): растёт при правке, удалении и реакции */
  v: number;
  /** Своё сообщение подтверждено устройством получателя */
  delivered?: boolean;
}

export interface OutboxOp {
  op: string;
  owner: string;
  dm: string;
  /** Пользователь-получатель (собеседник) */
  to: string;
  kind: OpKind;
  data: Record<string, unknown>;
  created: number;
  attempts: number;
}

export interface P2pStore {
  messagesFor(owner: string, dm: string, limit?: number): Promise<StoredMessage[]>;
  getMessage(id: string): Promise<StoredMessage | null>;
  putMessage(m: StoredMessage): void;
  deleteMessage(id: string): void;
  outbox(owner: string, dm?: string): Promise<OutboxOp[]>;
  putOp(op: OutboxOp): void;
  removeOp(op: string): void;
  isSeen(op: string): Promise<boolean>;
  markSeen(op: string): void;
  flush(): Promise<void>;
}

export function toMessage(s: StoredMessage): Message {
  return {
    id: s.id,
    channel_id: null,
    dm_id: s.dm_id,
    author_id: s.author_id,
    kind: s.kind,
    content: s.deleted_at ? '' : s.content,
    reply_to_id: s.reply_to_id,
    attachments: [],
    mentions: [],
    mention_everyone: false,
    reactions: s.deleted_at ? {} : s.reactions,
    edited_at: s.edited_at,
    deleted_at: s.deleted_at,
    created_at: s.created_at,
    _via: 'p2p',
    ...(s.author_id === s.owner ? { _delivery: s.delivered ? ('delivered' as const) : ('queued' as const) } : {}),
  };
}

/** Хранилище в памяти — для тестов и как запасной вариант, если IndexedDB недоступна */
export class MemoryStore implements P2pStore {
  msgs = new Map<string, StoredMessage>();
  ops = new Map<string, OutboxOp>();
  seen = new Map<string, number>();
  async messagesFor(owner: string, dm: string, limit = 500) {
    return [...this.msgs.values()]
      .filter((m) => m.owner === owner && m.dm_id === dm)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-limit);
  }
  async getMessage(id: string) {
    return this.msgs.get(id) ?? null;
  }
  putMessage(m: StoredMessage) {
    this.msgs.set(m.id, { ...m });
  }
  deleteMessage(id: string) {
    this.msgs.delete(id);
  }
  async outbox(owner: string, dm?: string) {
    return [...this.ops.values()].filter((o) => o.owner === owner && (!dm || o.dm === dm)).sort((a, b) => a.created - b.created);
  }
  putOp(op: OutboxOp) {
    this.ops.set(op.op, { ...op });
  }
  removeOp(op: string) {
    this.ops.delete(op);
  }
  async isSeen(op: string) {
    return this.seen.has(op);
  }
  markSeen(op: string) {
    this.seen.set(op, Date.now());
  }
  async flush() {}
}

const DB = 'rv-p2p';
const SEEN_TTL = 30 * 24 * 3600 * 1000;

type Pending = { store: 'messages' | 'outbox' | 'seen'; key: string; value: unknown | null };

interface SealedMessage {
  id: string;
  owner: string;
  dm_id: string;
  enc?: string;
}

interface SealedOp {
  op: string;
  owner: string;
  enc?: string;
}

/** IndexedDB с пакетной записью и шифрованием содержимого */
export class IdbStore implements P2pStore {
  private db: Promise<IDBDatabase>;
  private pending = new Map<string, Pending>();
  /** Пишется прямо сейчас (между очисткой очереди и завершением транзакции) */
  private inflight = new Map<string, Pending>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Ещё не записанное видно сразу (чтение сначала смотрит сюда) */
  private overlay(store: Pending['store'], key: string): Pending | undefined {
    return this.pending.get(`${store}:${key}`) ?? this.inflight.get(`${store}:${key}`);
  }

  private overlays(store: Pending['store']): Pending[] {
    return [...this.inflight.values(), ...this.pending.values()].filter((p) => p.store === store);
  }

  private async wrap(p: Pending): Promise<unknown> {
    if (p.value === null || p.store === 'seen') return p.value;
    const k = await this.key();
    if (p.store === 'messages') {
      const m = p.value as StoredMessage;
      return { id: m.id, owner: m.owner, dm_id: m.dm_id, enc: await sealJson(k, m, `m:${m.id}`) } satisfies SealedMessage;
    }
    const o = p.value as OutboxOp;
    return { op: o.op, owner: o.owner, enc: await sealJson(k, o, `o:${o.op}`) } satisfies SealedOp;
  }

  private async unwrapMsg(r: SealedMessage | StoredMessage | null): Promise<StoredMessage | null> {
    if (!r) return null;
    const enc = (r as SealedMessage).enc;
    if (typeof enc !== 'string') {
      // Запись 1.3.0 без шифрования — перешифровать
      if (!this.overlay('messages', r.id)) this.queue({ store: 'messages', key: r.id, value: r });
      return r as StoredMessage;
    }
    try {
      return await openJson<StoredMessage>(await this.key(), enc, `m:${r.id}`);
    } catch {
      return null; // повреждена или подменена
    }
  }

  private async unwrapOp(r: SealedOp | OutboxOp): Promise<OutboxOp | null> {
    const enc = (r as SealedOp).enc;
    if (typeof enc !== 'string') {
      if (!this.overlay('outbox', r.op)) this.queue({ store: 'outbox', key: r.op, value: r });
      return r as OutboxOp;
    }
    try {
      return await openJson<OutboxOp>(await this.key(), enc, `o:${r.op}`);
    } catch {
      return null;
    }
  }

  constructor(private readonly key: () => Promise<CryptoKey> = vaultKey) {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const m = db.createObjectStore('messages', { keyPath: 'id' });
        m.createIndex('owner_dm', ['owner', 'dm_id']);
        const o = db.createObjectStore('outbox', { keyPath: 'op' });
        o.createIndex('owner', 'owner');
        db.createObjectStore('seen', { keyPath: 'op' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    void this.cleanup();
  }

  private queue(p: Pending) {
    this.pending.set(`${p.store}:${p.key}`, p);
    this.timer ??= setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.size) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [k, p] of batch) this.inflight.set(k, p);
    try {
      // Шифрование — до открытия транзакции (транзакция IndexedDB не ждёт посторонних await)
      const rows = await Promise.all(batch.map(async ([, p]) => ({ p, value: await this.wrap(p) })));
      const db = await this.db;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['messages', 'outbox', 'seen'], 'readwrite');
        for (const { p, value } of rows) {
          const st = tx.objectStore(p.store);
          if (value === null) st.delete(p.key);
          else st.put(value);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      for (const [k, p] of batch) if (this.inflight.get(k) === p) this.inflight.delete(k);
    }
  }

  private async getAll<T>(store: string, index: string | null, query: IDBValidKey | IDBKeyRange | null): Promise<T[]> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const st = db.transaction(store, 'readonly').objectStore(store);
      const req = index ? st.index(index).getAll(query ?? undefined) : st.getAll(query ?? undefined);
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  }

  private async get<T>(store: string, key: string): Promise<T | null> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async messagesFor(owner: string, dm: string, limit = 500): Promise<StoredMessage[]> {
    const sealed = await this.getAll<SealedMessage>('messages', 'owner_dm', [owner, dm]);
    const rows = (await Promise.all(sealed.map((r) => this.unwrapMsg(r)))).filter((r): r is StoredMessage => !!r);
    const map = new Map(rows.map((r) => [r.id, r]));
    for (const p of this.overlays('messages')) {
      if (p.value === null) map.delete(p.key);
      else if ((p.value as StoredMessage).owner === owner && (p.value as StoredMessage).dm_id === dm) map.set(p.key, p.value as StoredMessage);
    }
    return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-limit);
  }

  async getMessage(id: string) {
    const o = this.overlay('messages', id);
    if (o) return (o.value as StoredMessage | null) ?? null;
    return this.unwrapMsg(await this.get<SealedMessage>('messages', id));
  }

  putMessage(m: StoredMessage) {
    this.queue({ store: 'messages', key: m.id, value: { ...m } });
  }

  deleteMessage(id: string) {
    this.queue({ store: 'messages', key: id, value: null });
  }

  async outbox(owner: string, dm?: string): Promise<OutboxOp[]> {
    const sealed = await this.getAll<SealedOp>('outbox', 'owner', owner);
    const rows = (await Promise.all(sealed.map((r) => this.unwrapOp(r)))).filter((r): r is OutboxOp => !!r);
    const map = new Map(rows.map((r) => [r.op, r]));
    for (const p of this.overlays('outbox')) {
      if (p.value === null) map.delete(p.key);
      else if ((p.value as OutboxOp).owner === owner) map.set(p.key, p.value as OutboxOp);
    }
    return [...map.values()].filter((o) => !dm || o.dm === dm).sort((a, b) => a.created - b.created);
  }

  putOp(op: OutboxOp) {
    this.queue({ store: 'outbox', key: op.op, value: { ...op } });
  }

  removeOp(op: string) {
    this.queue({ store: 'outbox', key: op, value: null });
  }

  async isSeen(op: string) {
    const o = this.overlay('seen', op);
    if (o) return o.value !== null;
    return !!(await this.get('seen', op));
  }

  markSeen(op: string) {
    this.queue({ store: 'seen', key: op, value: { op, at: Date.now() } });
  }

  /** Старые отметки о принятых операциях больше не нужны */
  private async cleanup() {
    try {
      const rows = await this.getAll<{ op: string; at: number }>('seen', null, null);
      const old = Date.now() - SEEN_TTL;
      for (const r of rows) if (r.at < old) this.queue({ store: 'seen', key: r.op, value: null });
    } catch {
      /* не критично */
    }
  }
}

let shared: P2pStore | null = null;
export function p2pStore(): P2pStore {
  if (!shared) {
    try {
      shared = typeof indexedDB !== 'undefined' ? new IdbStore() : new MemoryStore();
    } catch {
      shared = new MemoryStore();
    }
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => void shared?.flush());
  }
  return shared;
}
