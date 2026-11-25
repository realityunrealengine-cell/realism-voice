// Each async session operation captures the signal before its first await.
let lifetime = new AbortController();

export function sessionSignal(): AbortSignal {
  return lifetime.signal;
}

export function invalidateSession(): void {
  const previous = lifetime;
  lifetime = new AbortController();
  previous.abort();
}
