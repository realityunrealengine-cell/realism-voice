// Ход загрузок и скачиваний вложений (для карточек в чате).
import { create } from 'zustand';
import type { DownloadProgress, TransferPhase } from '../../electron/shared';
import { useUi } from './ui';

export type UploadPhase = TransferPhase | 'queued' | 'reserving' | 'sending';

export interface UploadView {
  id: string;
  messageId: string;
  name: string;
  kind: 'file' | 'folder';
  phase: UploadPhase;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  packedFiles?: number;
  totalFiles?: number;
  error?: string | null;
}

export interface DownloadView extends Omit<DownloadProgress, 'id'> {
  key: string;
  name: string;
}

interface TransfersState {
  uploads: Record<string, UploadView>;
  downloads: Record<string, DownloadView>;
  setUpload: (id: string, patch: Partial<UploadView>) => void;
  removeUpload: (id: string) => void;
  setDownload: (key: string, patch: Partial<DownloadView>) => void;
  removeDownload: (key: string) => void;
}

export const useTransfers = create<TransfersState>((set, get) => ({
  uploads: {},
  downloads: {},
  setUpload: (id, patch) => {
    const prev = get().uploads[id];
    if (!prev && !patch.messageId) return;
    set({ uploads: { ...get().uploads, [id]: { ...(prev ?? ({} as UploadView)), ...patch, id } as UploadView } });
  },
  removeUpload: (id) => {
    const { [id]: _x, ...rest } = get().uploads;
    set({ uploads: rest });
  },
  setDownload: (key, patch) => {
    const prev = get().downloads[key];
    set({ downloads: { ...get().downloads, [key]: { ...(prev ?? ({ transferred: 0, total: 0, bytesPerSecond: 0 } as DownloadView)), ...patch, key } as DownloadView } });
  },
  removeDownload: (key) => {
    const { [key]: _x, ...rest } = get().downloads;
    set({ downloads: rest });
  },
}));

// События main-процесса → состояние
let subscribed = false;
const downloadKeys = new Map<string, string>();

export function bindDownloadKey(id: string, key: string) {
  downloadKeys.set(id, key);
}

export function subscribeTransferEvents() {
  if (subscribed || !window.rv?.files) return;
  subscribed = true;
  window.rv.files.onUploadProgress((p) => {
    const s = useTransfers.getState();
    if (!s.uploads[p.id]) return;
    s.setUpload(p.id, {
      phase: p.phase,
      transferred: p.transferred,
      total: p.total || s.uploads[p.id].total,
      bytesPerSecond: p.bytesPerSecond,
      packedFiles: p.packedFiles,
      totalFiles: p.totalFiles,
      error: p.error ?? null,
    });
  });
  window.rv.files.onDownloadProgress((p) => {
    const key = downloadKeys.get(p.id);
    if (!key) return;
    const { id: _id, ...rest } = p;
    useTransfers.getState().setDownload(key, rest);
    const name = useTransfers.getState().downloads[key]?.name ?? 'Файл';
    if (p.phase === 'done' && p.savedPath) {
      const saved = p.savedPath;
      useUi.getState().toast({
        kind: 'success',
        title: key.endsWith('#folder') ? 'Папка сохранена' : 'Файл сохранён',
        body: name,
        action: { label: 'Показать в папке', onClick: () => void window.rv?.files.showInFolder(saved) },
      });
    } else if (p.phase === 'error') {
      useUi.getState().toast({ kind: 'error', title: 'Не удалось скачать', body: p.error ?? name });
    }
    if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') downloadKeys.delete(p.id);
  });
}

/** «12,4 МБ/с» */
export function formatSpeed(bps: number): string {
  if (!bps || bps < 1) return '';
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} КБ/с`;
  return `${(bps / 1024 / 1024).toFixed(1).replace('.', ',')} МБ/с`;
}

export function percent(done: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}
