import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message, OutgoingItem, Scope } from '@/lib/types';
import { useMessages } from '@/stores/messages';
import { useTransfers } from '@/stores/transfers';

const { insert, select, reserve, upload, remove } = vi.hoisted(() => ({
  insert: vi.fn(), select: vi.fn(), reserve: vi.fn(), upload: vi.fn(), remove: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ insert, select }) } }));
vi.mock('@/lib/media', () => ({
  maxAttachmentBytes: async () => 1024, imageSize: async () => null,
  reserveAttachment: reserve, uploadBlob: upload, removeAttachments: remove,
  tusEndpoint: () => 'tus', accessToken: async () => 'token', publishableKey: () => 'key',
}));
vi.mock('@/stores/auth', () => ({ useAuth: { getState: () => ({ userId: 'author' }) } }));
vi.mock('@/stores/profiles', () => ({ useProfiles: { getState: () => ({ ensure: vi.fn() }) } }));
vi.mock('@/stores/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const scope: Scope = { kind: 'dm', id: 'chat' };
const store = () => useMessages.getState();
const rows = () => store().byScope[scope.id].messages;
function blob(name: string): OutgoingItem {
  return { key: name, name, kind: 'file', size: 1, blob: new Blob(['x']) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function serverRow(input: Partial<Message>): Message {
  return { ...rows()[0], ...input, _status: undefined, created_at: '2026-01-01T00:00:00Z' };
}
function delayInsert() {
  const submitted = deferred<Message>();
  const response = deferred<{ data: Message | null; error: { message: string } | null }>();
  insert.mockImplementation((input) => ({
    select: () => ({
      single: () => {
        submitted.resolve(serverRow(input));
        return response.promise;
      },
    }),
  }));
  return { submitted, response };
}

beforeEach(() => {
  vi.resetAllMocks();
  store().reset();
  useTransfers.setState({ uploads: {} });
  reserve.mockImplementation(async (_scope, _uid, name) => ({ path: 'files/' + name }));
  remove.mockResolvedValue(undefined);
  insert.mockImplementation((input) => ({
    select: () => ({ single: async () => ({ data: serverRow(input), error: null }) }),
  }));
});
afterEach(() => vi.unstubAllGlobals());

it.each(['Realtime first', 'response first'])('merges both confirmations by message ID: %s', async (order) => {
  const { submitted, response } = delayInsert();
  const sending = store().send(scope, 'hello', [blob('one')], 'reply');
  const optimistic = rows()[0];
  expect(optimistic._status).toBe('sending');
  const row = await submitted.promise;
  expect(row).toMatchObject({ id: optimistic.id, reply_to_id: 'reply', attachments: [{ path: 'files/one' }] });
  if (order === 'Realtime first') {
    store().applyRemote(row);
    expect(rows()).toEqual([row]);
  }
  response.resolve({ data: row, error: null });
  await sending;
  if (order === 'response first') {
    expect(rows()).toEqual([row]);
    store().applyRemote(row);
  }
  expect(rows()).toEqual([row]);
  expect(useTransfers.getState().uploads).toEqual({});
  expect(insert).toHaveBeenCalledTimes(1);
});

it('retries the failed upload with its reservation and keeps the completed attachment', async () => {
  upload.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('upload failed'));
  await expect(store().send(scope, 'text', [blob('a'), blob('b')], null)).rejects.toThrow('upload failed');
  const [failed] = rows();
  expect(failed).toMatchObject({ _status: 'failed', _error: 'upload failed' });
  expect(insert).not.toHaveBeenCalled();
  expect(Object.values(useTransfers.getState().uploads).map((u) => u.phase)).toEqual(['done', 'error']);
  await Promise.all([store().retry(scope, failed.id), store().retry(scope, failed.id)]);
  expect(reserve).toHaveBeenCalledTimes(2);
  expect(upload.mock.calls.map(([path]) => path)).toEqual(['files/a', 'files/b', 'files/b']);
  expect(rows()).toHaveLength(1);
  expect(rows()[0].id).toBe(failed.id);
  expect(rows()[0]._status).toBeUndefined();
  expect(rows()[0].attachments.map((a) => a.path)).toEqual(['files/a', 'files/b']);
  expect(insert).toHaveBeenCalledTimes(1);
});

it.each(['caption', ''])('cancels the only blob while upload is in flight (text %j)', async (text) => {
  const started = deferred<void>();
  const finish = deferred<void>();
  upload.mockImplementation(() => { started.resolve(); return finish.promise; });
  const sending = store().send(scope, text, [blob('a')], null);
  await started.promise;
  await store().cancelUpload(rows()[0].attachments[0]._uploadId!);
  finish.resolve();
  await sending;
  expect(remove).toHaveBeenCalledWith(['files/a']);
  expect(useTransfers.getState().uploads).toEqual({});
  expect(insert).toHaveBeenCalledTimes(text ? 1 : 0);
  if (text) expect(rows()[0]).toMatchObject({ content: text, attachments: [], _status: undefined });
  else expect(rows()).toEqual([]);
});

it('discards a failed send and releases desktop tokens and uploaded objects', async () => {
  const files = { prepare: vi.fn().mockResolvedValue({ size: 1, contentType: 'text/plain' }),
    upload: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('failed')),
    cancel: vi.fn(), release: vi.fn() };
  vi.stubGlobal('window', { rv: { files } });
  const items = ['a', 'b'].map((name): OutgoingItem => ({ key: name, name, kind: 'file', size: 1, token: name }));
  await expect(store().send(scope, '', items, null)).rejects.toThrow('failed');
  store().discard(scope, rows()[0].id);
  expect(rows()).toEqual([]);
  expect(remove).toHaveBeenCalledWith(['files/a']);
  expect(files.release).toHaveBeenCalledWith(['a', 'b']);
  expect(useTransfers.getState().uploads).toEqual({});
  expect(insert).not.toHaveBeenCalled();
});

it('keeps a Realtime-confirmed message when the insert response is lost', async () => {
  const { submitted, response } = delayInsert();
  const sending = store().send(scope, '', [blob('a')], null);
  const row = await submitted.promise;
  store().applyRemote(row);
  response.resolve({ data: null, error: { message: 'response lost' } });
  await sending;
  await store().retry(scope, row.id);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual([row]);
  expect(useTransfers.getState().uploads).toEqual({});
});

it('excludes a completed attachment cancelled while the next upload is running', async () => {
  const started = deferred<void>();
  const finish = deferred<void>();
  upload.mockResolvedValueOnce(undefined).mockImplementationOnce(() => { started.resolve(); return finish.promise; });
  const sending = store().send(scope, '', [blob('a'), blob('b')], null);
  await started.promise;
  await store().cancelUpload(rows()[0].attachments[0]._uploadId!);
  finish.resolve();
  await sending;
  expect(remove.mock.calls).toEqual([[['files/a']]]);
  expect(rows()[0].attachments.map((attachment) => attachment.path)).toEqual(['files/b']);
  expect(insert).toHaveBeenCalledTimes(1);
});

it('resumes a paused desktop upload using its original reservation and upload ID', async () => {
  const files = {
    prepare: vi.fn().mockResolvedValue({ size: 1, contentType: 'text/plain' }),
    upload: vi.fn().mockRejectedValueOnce(new Error('paused')).mockResolvedValueOnce(undefined),
    pause: vi.fn(), release: vi.fn(),
  };
  vi.stubGlobal('window', { rv: { files } });
  await store().send(scope, '', [{ key: 'a', name: 'a', kind: 'file', size: 1, token: 'file-a' }], null);
  const uploadId = rows()[0].attachments[0]._uploadId!;
  expect(rows()[0]._status).toBe('sending');
  expect(insert).not.toHaveBeenCalled();
  await store().resumeUpload(uploadId);
  expect(files.prepare).toHaveBeenCalledTimes(1);
  expect(reserve).toHaveBeenCalledTimes(1);
  expect(files.upload.mock.calls.map(([args]) => [args.id, args.objectPath])).toEqual([
    [uploadId, 'files/a'], [uploadId, 'files/a'],
  ]);
  expect(rows()[0]._status).toBeUndefined();
  expect(files.release.mock.calls).toEqual([[['file-a']]]);
  expect(useTransfers.getState().uploads).toEqual({});
});

it('accepts a history load as confirmation before an insert error arrives', async () => {
  const { submitted, response } = delayInsert();
  const sending = store().send(scope, 'text', [blob('a')], null);
  const row = await submitted.promise;
  const query = { order: () => query, limit: () => query, eq: async () => ({ data: [row] }) };
  select.mockReturnValue(query);
  await store().load(scope);
  response.resolve({ data: null, error: { message: 'response lost' } });
  await sending;
  expect(rows()).toEqual([row]);
  expect(useTransfers.getState().uploads).toEqual({});
});

it('preserves possibly committed files when discarding after a lost insert response', async () => {
  insert.mockReturnValue({ select: () => ({ single: async () => ({ error: { message: 'response lost' } }) }) });
  await expect(store().send(scope, '', [blob('a')], null)).rejects.toThrow('response lost');
  store().discard(scope, rows()[0].id);
  expect(remove).not.toHaveBeenCalled();
  expect(rows()).toEqual([]);
  expect(useTransfers.getState().uploads).toEqual({});
});

it('recovers the saved row by ID when a manual retry hits a duplicate key', async () => {
  insert.mockReturnValueOnce({ select: () => ({ single: async () => ({ error: { message: 'response lost' } }) }) })
    .mockReturnValueOnce({ select: () => ({ single: async () => ({ error: { code: '23505' } }) }) });
  await expect(store().send(scope, 'hey', [blob('a')], null)).rejects.toThrow('response lost');
  const row = serverRow(insert.mock.calls[0][0]);
  const eq = vi.fn().mockReturnValue({ single: async () => ({ data: row, error: null }) });
  select.mockReturnValue({ eq });
  await store().retry(scope, row.id);
  expect(eq).toHaveBeenCalledWith('id', row.id);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual([{ ...row, _error: undefined }]);
  expect(useTransfers.getState().uploads).toEqual({});
});

it('ignores an insert response delivered after the store resets', async () => {
  const { submitted, response } = delayInsert();
  const sending = store().send(scope, 'old', [blob('a')], null);
  const row = await submitted.promise;
  store().reset();
  response.resolve({ data: row, error: null });
  await sending;
  expect(store().byScope).toEqual({});
  expect(useTransfers.getState().uploads).toEqual({});
  expect(remove).not.toHaveBeenCalled();
});
