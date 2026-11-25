/**
 * Защита от перебора на этом устройстве (дополнительно к ограничениям сервера Supabase Auth):
 * после 5 неверных кодов — пауза 30 с, далее каждая ошибка удваивает паузу (до 15 минут).
 */
export class AttemptLimiter {
  private fails = 0;
  private until = 0;
  constructor(
    private readonly free = 5,
    private readonly baseMs = 30_000,
    private readonly maxMs = 15 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}
  /** Сколько миллисекунд ждать до следующей попытки (0 — можно) */
  wait(): number {
    return Math.max(0, this.until - this.now());
  }
  fail() {
    this.fails++;
    if (this.fails >= this.free) this.until = this.now() + Math.min(this.maxMs, this.baseMs * 2 ** (this.fails - this.free));
  }
  success() {
    this.fails = 0;
    this.until = 0;
  }
}
