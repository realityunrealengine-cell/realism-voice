import { create } from 'zustand';
import type { UpdateState } from '../../electron/shared';
import { toast } from './ui';

/** ready — можно перезапустить; in-call — обновление ждёт завершения звонка */
export type UpdateNoticeKind = 'ready' | 'in-call' | null;

interface UpdatesState {
  state: UpdateState | null;
  notice: UpdateNoticeKind;
  panelOpen: boolean;
  init: () => () => void;
  check: () => void;
  download: () => void;
  install: () => Promise<void>;
  setNotice: (notice: UpdateNoticeKind) => void;
  setPanelOpen: (open: boolean) => void;
}

export const useUpdates = create<UpdatesState>((set) => ({
  state: null,
  notice: null,
  panelOpen: false,
  init: () => {
    const off = window.rv?.updates.onState((state) => set({ state }));
    void window.rv?.updates.getState().then((state) => set({ state }));
    return () => off?.();
  },
  check: () => void window.rv?.updates.check(),
  download: () => void window.rv?.updates.download(),
  install: async () => {
    const started = await window.rv?.updates.install();
    if (!started) toast.error('Обновление пока нельзя установить', 'Завершите звонок и попробуйте снова');
  },
  setNotice: (notice) => set({ notice }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));
