import { create } from 'zustand';
import type { ReactNode } from 'react';

export type View =
  | { kind: 'home'; tab: 'online' | 'all' | 'pending' | 'blocked' | 'add' }
  | { kind: 'dm'; dmId: string }
  | { kind: 'server'; serverId: string };

export type Modal =
  | { type: 'createServer' }
  | { type: 'joinServer'; code?: string }
  | { type: 'createChannel'; serverId: string; categoryId: string | null; channelType?: 'text' | 'voice' }
  | { type: 'createCategory'; serverId: string; categoryId?: string; name?: string }
  | { type: 'channelSettings'; channelId: string }
  | { type: 'serverSettings'; serverId: string; tab?: string }
  | { type: 'invite'; serverId: string }
  | { type: 'profile'; userId: string; serverId?: string }
  | { type: 'inviteFriend'; userId: string }
  | { type: 'screenPicker' }
  | { type: 'confirm'; title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void };

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  separator?: boolean;
}

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  timeout?: number;
}

interface UiState {
  view: View;
  lastChannel: Record<string, string>; // serverId -> текстовый канал
  voiceViewOpen: boolean; // центральная панель показывает голосовой канал
  settingsOpen: boolean;
  settingsSection: string;
  memberListOpen: boolean;
  modal: Modal | null;
  modalStack: Modal[];
  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null;
  toasts: Toast[];
  replyTo: Record<string, string | null>; // scopeId -> messageId
  editing: string | null;
  setView: (v: View) => void;
  openChannel: (serverId: string, channelId: string) => void;
  setVoiceViewOpen: (open: boolean) => void;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  toggleMemberList: () => void;
  openModal: (m: Modal) => void;
  closeModal: () => void;
  openContextMenu: (e: { clientX: number; clientY: number }, items: ContextMenuItem[]) => void;
  closeContextMenu: () => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  setReplyTo: (scopeId: string, messageId: string | null) => void;
  setEditing: (id: string | null) => void;
}

let toastId = 1;

export const useUi = create<UiState>((set, get) => ({
  view: { kind: 'home', tab: 'online' },
  lastChannel: {},
  voiceViewOpen: false,
  settingsOpen: false,
  settingsSection: 'account',
  memberListOpen: true,
  modal: null,
  modalStack: [],
  contextMenu: null,
  toasts: [],
  replyTo: {},
  editing: null,
  setView: (view) => set({ view, voiceViewOpen: false, editing: null }),
  openChannel: (serverId, channelId) =>
    set({
      view: { kind: 'server', serverId },
      lastChannel: { ...get().lastChannel, [serverId]: channelId },
      voiceViewOpen: false,
      editing: null,
    }),
  setVoiceViewOpen: (voiceViewOpen) => set({ voiceViewOpen }),
  openSettings: (section = 'account') => set({ settingsOpen: true, settingsSection: section }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleMemberList: () => set({ memberListOpen: !get().memberListOpen }),
  openModal: (m) => {
    const cur = get().modal;
    set({ modal: m, modalStack: cur ? [...get().modalStack, cur] : get().modalStack });
  },
  closeModal: () => {
    const stack = [...get().modalStack];
    const prev = stack.pop() ?? null;
    set({ modal: prev, modalStack: stack });
  },
  openContextMenu: (e, items) => set({ contextMenu: { x: e.clientX, y: e.clientY, items } }),
  closeContextMenu: () => set({ contextMenu: null }),
  toast: (t) => {
    const id = toastId++;
    set({ toasts: [...get().toasts, { ...t, id }] });
    const timeout = t.timeout ?? (t.kind === 'error' ? 7000 : 4500);
    if (timeout > 0) setTimeout(() => get().dismissToast(id), timeout);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setReplyTo: (scopeId, messageId) => set({ replyTo: { ...get().replyTo, [scopeId]: messageId } }),
  setEditing: (editing) => set({ editing }),
}));

export const toast = {
  info: (title: string, body?: string) => useUi.getState().toast({ kind: 'info', title, body }),
  success: (title: string, body?: string) => useUi.getState().toast({ kind: 'success', title, body }),
  error: (title: string, body?: string) => useUi.getState().toast({ kind: 'error', title, body }),
};
