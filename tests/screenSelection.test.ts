import { beforeEach, expect, it, vi } from 'vitest';
import type { RvBridge } from '../electron/shared';
import { setupScreenSelection } from '../electron/screenSelection';
import '../electron/preload';

const { handle, invoke, expose, getSources, setDisplayHandler } = vi.hoisted(() => ({
  handle: vi.fn(), invoke: vi.fn(), expose: vi.fn(), getSources: vi.fn(), setDisplayHandler: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle }, ipcRenderer: { invoke }, contextBridge: { exposeInMainWorld: expose },
  desktopCapturer: { getSources }, session: { defaultSession: { setDisplayMediaRequestHandler: setDisplayHandler } },
}));

const screen = (expose.mock.calls.find(([key]) => key === 'rv')![1] as RvBridge).screen;
const trustedEvent = { senderFrame: { name: 'main' } };
const deniedEvent = { senderFrame: { name: 'child' } };
let sender = trustedEvent;
const checkSender = vi.fn((event: unknown) => event === trustedEvent);
const thumbnail = { toDataURL: () => 'thumbnail' };
const monitor = { id: 'screen:1:0', name: 'Realism Voice', thumbnail, appIcon: null };
const editor = { id: 'window:2:0', name: 'Editor', thumbnail, appIcon: { isEmpty: () => false, toDataURL: () => 'icon' } };

beforeEach(() => {
  sender = trustedEvent;
  handle.mockClear();
  checkSender.mockClear();
  setDisplayHandler.mockClear();
  getSources.mockReset().mockResolvedValue([monitor, editor]);
  invoke.mockImplementation(async (channel, ...args) => {
    const entry = handle.mock.calls.find(([key]) => key === channel);
    if (!entry) throw new Error('Unregistered IPC channel: ' + channel);
    return entry[1](sender, ...args);
  });
  setupScreenSelection(checkSender);
});

async function requestCapture() {
  const reply = vi.fn();
  await setDisplayHandler.mock.calls[0][0]({}, reply);
  expect(reply).toHaveBeenCalledTimes(1);
  return reply.mock.calls[0][0];
}

it('returns picker previews through the preload bridge and filters the app window', async () => {
  getSources.mockResolvedValue([monitor, { ...editor, name: 'Realism Voice' }, editor]);
  expect(await screen.getSources()).toEqual([
    { id: monitor.id, name: monitor.name, kind: 'screen', thumbnail: 'thumbnail', appIcon: null },
    { id: editor.id, name: editor.name, kind: 'window', thumbnail: 'thumbnail', appIcon: 'icon' },
  ]);
  expect(getSources).toHaveBeenCalledWith({
    types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true,
  });
  expect(checkSender).toHaveBeenCalledWith(trustedEvent);
});

it('checks the sender before listing or changing a pending selection', async () => {
  await screen.select(editor.id, false);
  sender = deniedEvent;
  expect(await screen.getSources()).toEqual([]);
  await screen.select(null, false);
  await screen.select(monitor.id, true);
  expect(checkSender.mock.calls.map(([e]) => e)).toEqual([trustedEvent, deniedEvent, deniedEvent, deniedEvent]);
  expect(getSources).not.toHaveBeenCalled();
  expect(await requestCapture()).toEqual({ video: editor });
});

it.each([null, '', 'invalid'])('clears an earlier selection on cancellation or invalid ID (%s)', async (id) => {
  await screen.select(editor.id, true);
  await screen.select(id, false);
  expect(await requestCapture()).toEqual({});
  expect(getSources).not.toHaveBeenCalled();
});

it('consumes the latest selection before asynchronous source enumeration finishes', async () => {
  let finish!: (sources: typeof monitor[]) => void;
  getSources.mockReturnValueOnce(new Promise<typeof monitor[]>((resolve) => { finish = resolve; }));
  await screen.select(editor.id, false);
  await screen.select(monitor.id, true);
  const first = requestCapture();
  expect(await requestCapture()).toEqual({});
  await screen.select(editor.id, false);
  finish([monitor]);
  expect(await first).toEqual(process.platform === 'win32' ? { video: monitor, audio: 'loopback' } : { video: monitor });
  expect(await requestCapture()).toEqual({ video: editor });
  expect(getSources).toHaveBeenCalledTimes(2);
});

it.each(['gone', 'error'])('denies capture and consumes the selection when enumeration returns %s', async (outcome) => {
  await screen.select(editor.id, false);
  if (outcome === 'gone') getSources.mockResolvedValueOnce([monitor]);
  else getSources.mockRejectedValueOnce(new Error('Capture unavailable'));
  expect(await requestCapture()).toEqual({});
  expect(await requestCapture()).toEqual({});
  expect(getSources).toHaveBeenCalledTimes(1);
});
