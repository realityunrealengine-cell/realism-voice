// Список доверия к ключам устройств (TOFU — «доверие при первой встрече», как в Signal/SSH).
//
//   * первый ключ собеседника запоминается автоматически;
//   * новое устройство или смена ключа — соединение разрешается, но пользователь получает предупреждение,
//     а отметка «проверено» с этого собеседника снимается;
//   * отозванному ключу соединение запрещено (P2P с этим устройством не устанавливается);
//   * «проверено» ставит сам пользователь после сверки кода безопасности.
// Хранятся только ОТКРЫТЫЕ ключи — они не секретны, поэтому достаточно обычного хранилища.
import { decodePublic, encodePublic, fingerprint, type PublicIdentity } from './identity';

export interface KnownKey {
  fp: string;
  ed: string;
  pq: string;
  firstSeen: number;
  lastSeen: number;
  verified: boolean;
  revoked: boolean;
}

export type Observation = 'first' | 'known' | 'new-key' | 'revoked';

export interface TrustPersistence {
  load(): Record<string, KnownKey[]>;
  save(state: Record<string, KnownKey[]>): void;
}

export const localTrustPersistence = (key = 'rv-p2p-trust-v1'): TrustPersistence => ({
  load: () => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  },
  save: (s) => {
    try {
      localStorage.setItem(key, JSON.stringify(s));
    } catch {
      /* хранилище недоступно */
    }
  },
});

export class TrustStore {
  private state: Record<string, KnownKey[]>;
  private listeners = new Set<() => void>();
  /** Растёт при каждом изменении (для подписки интерфейса) */
  version = 0;

  constructor(
    private readonly p: TrustPersistence,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = p.load();
  }

  private commit() {
    this.version++;
    this.p.save(this.state);
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Встретили ключ устройства пользователя: запомнить и сказать, что это за ключ */
  observe(userId: string, pub: PublicIdentity): Observation {
    const fp = fingerprint(pub);
    const list = this.state[userId] ?? [];
    const k = list.find((x) => x.fp === fp);
    if (k) {
      if (k.revoked) return 'revoked';
      k.lastSeen = this.now();
      this.commit();
      return 'known';
    }
    const first = list.length === 0;
    const e = encodePublic(pub);
    // Новый ключ: прежняя проверка кода больше не гарантирует отсутствие посредника
    const next = list.map((x) => ({ ...x, verified: false }));
    next.push({ fp, ed: e.ed, pq: e.pq, firstSeen: this.now(), lastSeen: this.now(), verified: false, revoked: false });
    this.state[userId] = next.slice(-20);
    this.commit();
    return first ? 'first' : 'new-key';
  }

  allowed(userId: string, pub: PublicIdentity): boolean {
    const fp = fingerprint(pub);
    return !(this.state[userId] ?? []).some((x) => x.fp === fp && x.revoked);
  }

  keys(userId: string): (KnownKey & { pub: PublicIdentity | null })[] {
    return (this.state[userId] ?? []).map((k) => ({ ...k, pub: decodePublic({ ed: k.ed, pq: k.pq }) }));
  }

  users(): string[] {
    return Object.keys(this.state);
  }

  setVerified(userId: string, fp: string, verified: boolean) {
    const k = this.state[userId]?.find((x) => x.fp === fp);
    if (!k) return;
    k.verified = verified;
    this.commit();
  }

  setRevoked(userId: string, fp: string, revoked: boolean) {
    const k = this.state[userId]?.find((x) => x.fp === fp);
    if (!k) return;
    k.revoked = revoked;
    if (revoked) k.verified = false;
    this.commit();
  }
}
