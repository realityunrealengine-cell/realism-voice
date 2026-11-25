import { desktopCapturer, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import type { ScreenSource } from './shared';

export function setupScreenSelection(assertSender: (event: IpcMainInvokeEvent) => boolean) {
  let pendingScreen: { id: string; withAudio: boolean } | null = null;

  ipcMain.handle('screen:sources', async (e): Promise<ScreenSource[]> => {
    if (!assertSender(e)) return [];
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.name !== 'Realism Voice' || s.id.startsWith('screen'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      }));
  });

  ipcMain.handle('screen:select', (e, id, withAudio) => {
    if (!assertSender(e)) return;
    pendingScreen =
      typeof id === 'string' && /^(screen|window):[\w:.-]{1,64}$/.test(id) ? { id, withAudio: withAudio === true } : null;
  });

  // Демонстрация экрана: источник выбирается в UI приложения (screen:select)
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const selection = pendingScreen;
    pendingScreen = null;
    if (!selection) {
      callback({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === selection.id);
      if (!source) {
        callback({});
        return;
      }
      callback(
        selection.withAudio && process.platform === 'win32'
          ? { video: source, audio: 'loopback' }
          : { video: source },
      );
    } catch {
      callback({});
    }
  });
}
