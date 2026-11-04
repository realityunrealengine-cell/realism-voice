import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

interface ProfilesState {
  byId: Record<string, Profile>;
  upsert: (profiles: Profile[]) => void;
  ensure: (ids: (string | null | undefined)[]) => void;
  fetchOne: (id: string) => Promise<Profile | null>;
}

const requested = new Set<string>();
let queue = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export const useProfiles = create<ProfilesState>((set, get) => ({
  byId: {},
  upsert: (profiles) => {
    if (profiles.length === 0) return;
    const next = { ...get().byId };
    for (const p of profiles) next[p.id] = p;
    set({ byId: next });
  },
  ensure: (ids) => {
    const byId = get().byId;
    for (const id of ids) {
      if (id && !byId[id] && !requested.has(id)) {
        requested.add(id);
        queue.add(id);
      }
    }
    if (queue.size === 0 || timer) return;
    timer = setTimeout(async () => {
      const batch = [...queue];
      queue = new Set();
      timer = null;
      for (let i = 0; i < batch.length; i += 100) {
        const chunk = batch.slice(i, i + 100);
        const { data } = await supabase.from('profiles').select('*').in('id', chunk);
        if (data) get().upsert(data as Profile[]);
        else chunk.forEach((id) => requested.delete(id));
      }
    }, 30);
  },
  fetchOne: async (id) => {
    const { data } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();
    if (data) get().upsert([data as Profile]);
    return (data as Profile) ?? null;
  },
}));

export function useProfile(id: string | null | undefined): Profile | undefined {
  const p = useProfiles((s) => (id ? s.byId[id] : undefined));
  if (id && !p) useProfiles.getState().ensure([id]);
  return p;
}
