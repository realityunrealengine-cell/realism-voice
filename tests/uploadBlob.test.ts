// Скриншот из буфера обмена загружается «как есть», а не multipart-формой: иначе Supabase Storage проверяет
// права по размеру всего запроса (с границами формы), он больше резерва, и загрузка отклоняется.
import { describe, expect, it, vi } from 'vitest';

const upload = vi.fn(async (..._a: unknown[]) => ({ error: null }));
vi.mock('@/lib/supabase', () => ({
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'k',
  supabase: { storage: { from: () => ({ upload }) } },
}));
vi.mock('@/lib/errors', () => ({ errorMessage: (e: Error) => e.message, isMissingFunction: () => false }));

const { uploadBlob } = await import('@/lib/media');

describe('загрузка скриншота', () => {
  it('тело — байты файла точного размера, не Blob/FormData', async () => {
    const png = new Blob([new Uint8Array(1234)], { type: 'image/png' });
    await uploadBlob('dms/x/u/1-image.png', png, 'image/png');
    const [path, body, opts] = upload.mock.calls[0] as [string, unknown, { contentType: string }];
    expect(path).toBe('dms/x/u/1-image.png');
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body).not.toBeInstanceOf(Blob);
    expect((body as Uint8Array).byteLength).toBe(1234);
    expect(opts.contentType).toBe('image/png');
  });
});
