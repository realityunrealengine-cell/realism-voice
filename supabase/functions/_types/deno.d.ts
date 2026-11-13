// Минимальные объявления среды Supabase Edge Functions (Deno) для проверки типов через tsc.
declare namespace Deno {
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
  const env: { get(name: string): string | undefined };
}
