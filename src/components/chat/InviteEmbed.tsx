import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useServers } from '@/stores/servers';
import { toast, useUi } from '@/stores/ui';
import { ServerIcon } from '@/components/ui/Avatar';
import { Spinner } from '@/components/ui/primitives';
import { plural } from '@/lib/format';

interface Preview {
  server_id: string;
  name: string;
  description: string;
  icon_path: string | null;
  member_count: number;
  already_member: boolean;
}

export function useInvitePreview(code: string | undefined) {
  const [state, setState] = useState<{ loading: boolean; data: Preview | null; error: string | null }>({ loading: !!code, data: null, error: null });
  useEffect(() => {
    if (!code) return;
    let alive = true;
    setState({ loading: true, data: null, error: null });
    void supabase.rpc('preview_invite', { p_code: code }).then(({ data, error }) => {
      if (!alive) return;
      const row = Array.isArray(data) ? (data[0] as Preview | undefined) : undefined;
      setState({ loading: false, data: row ?? null, error: error ? error.message : row ? null : 'Приглашение недействительно или истекло' });
    });
    return () => {
      alive = false;
    };
  }, [code]);
  return state;
}

export function InviteEmbed({ code }: { code: string }) {
  const { loading, data, error } = useInvitePreview(code);
  const [joining, setJoining] = useState(false);
  const join = async () => {
    if (!data) return;
    if (data.already_member) {
      useUi.getState().setView({ kind: 'server', serverId: data.server_id });
      return;
    }
    setJoining(true);
    try {
      const id = await useServers.getState().joinServer(code);
      useUi.getState().setView({ kind: 'server', serverId: id });
      toast.success(`Добро пожаловать на «${data.name}»!`);
    } catch (e) {
      toast.error('Не удалось вступить', (e as Error).message);
    } finally {
      setJoining(false);
    }
  };
  return (
    <div className="mt-2 w-[400px] max-w-full rounded-xl border border-white/10 bg-black/25 p-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Приглашение на сервер</div>
      {loading ? (
        <Spinner />
      ) : !data ? (
        <div className="text-sm text-slate-500">{error}</div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 overflow-hidden rounded-2xl">
            <ServerIcon id={data.server_id} name={data.name} iconPath={data.icon_path} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-white">{data.name}</div>
            <div className="flex items-center gap-1 text-xs text-slate-400">
              <Users className="h-3 w-3" /> {data.member_count} {plural(data.member_count, 'участник', 'участника', 'участников')}
            </div>
          </div>
          <button className="btn-primary" onClick={() => void join()} disabled={joining}>
            {joining && <Spinner />}
            {data.already_member ? 'Перейти' : 'Вступить'}
          </button>
        </div>
      )}
    </div>
  );
}
