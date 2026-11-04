import { create } from 'zustand';
import { sounds } from '@/lib/sounds';

export interface IncomingCall {
  dmId: string;
  from: string;
  at: number;
}

interface CallsState {
  incoming: IncomingCall | null;
  ring: (c: { dmId: string; from: string }) => void;
  dismiss: () => void;
}

let ringTimer: ReturnType<typeof setInterval> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

export const useCalls = create<CallsState>((set) => ({
  incoming: null,
  ring: ({ dmId, from }) => {
    set({ incoming: { dmId, from, at: Date.now() } });
    sounds.ring();
    if (ringTimer) clearInterval(ringTimer);
    if (stopTimer) clearTimeout(stopTimer);
    ringTimer = setInterval(() => sounds.ring(), 2500);
    stopTimer = setTimeout(() => useCalls.getState().dismiss(), 45_000);
  },
  dismiss: () => {
    if (ringTimer) clearInterval(ringTimer);
    if (stopTimer) clearTimeout(stopTimer);
    ringTimer = stopTimer = null;
    set({ incoming: null });
  },
}));
