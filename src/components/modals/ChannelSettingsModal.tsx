import { useEffect, useMemo, useState } from 'react';
import { Hash, Lock, Trash2, Volume2 } from 'lucide-react';
import { useServers } from '@/stores/servers';
import { useProfiles } from '@/stores/profiles';
import { toast, useUi } from '@/stores/ui';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { ROLE_LABEL, type ServerRole } from '@/lib/types';
import { Avatar } from '@/components/ui/Avatar';
import { Field, ModalShell, Select, Spinner, Switch } from '@/components/ui/primitives';

const ROLE_OPTIONS: { value: ServerRole; label: string }[] = (['member', 'moderator', 'admin', 'owner'] as ServerRole[]).map((r) => ({
  value: r,
  label: ROLE_LABEL[r],
}));

export function ChannelSettingsModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useServers((s) => Object.values(s.channels).flat().find((c) => c.id === channelId));
  const members = useServers((s) => (channel ? s.members[channel.server_id] : undefined));
  const profiles = useProfiles((s) => s.byId);
  const [form, setForm] = useState(() => channel && { ...channel });
  const [allowed, setAllowed] = useState<string[]>([]);
  const [allowedLoaded, setAllowedLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!channel) return;
    if (!members) void useServers.getState().loadMembers(channel.server_id);
    void supabase
      .from('channel_allowed_members')
      .select('user_id')
      .eq('channel_id', channelId)
      .then(({ data }) => {
        setAllowed(((data ?? []) as { user_id: string }[]).map((r) => r.user_id));
        setAllowedLoaded(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const visibleMembers = useMemo(
    () =>
      (members ?? [])
        .filter((m) => m.role !== 'owner' && m.role !== 'admin')
        .filter((m) => {
          const p = profiles[m.user_id];
          return !filter || p?.display_name.toLowerCase().includes(filter.toLowerCase()) || p?.username.includes(filter.toLowerCase());
        }),
    [members, profiles, filter],
  );

  if (!channel || !form) return null;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await useServers.getState().updateChannel(channelId, {
        name: form.name,
        topic: form.topic,
        is_private: form.is_private,
        min_role: form.min_role,
        send_min_role: form.send_min_role,
        slowmode_seconds: form.slowmode_seconds,
        user_limit: form.type === 'voice' ? form.user_limit : null,
      });
      if (form.is_private && allowedLoaded) {
        const { error: e } = await supabase.rpc('set_channel_allowed_members', { p_channel: channelId, p_users: allowed });
        if (e) throw e;
      }
      toast.success('Канал сохранён');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open onClose={onClose} width="max-w-xl" title={<span className="flex items-center gap-2">{channel.type === 'text' ? <Hash className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />} Настройки канала</span>}>
      <div className="space-y-4 px-6 pb-6 pt-3">
        <Field label="Название">
          <input className="input" value={form.name} maxLength={64} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {channel.type === 'text' && (
          <Field label="Тема канала">
            <textarea className="input resize-none" rows={2} maxLength={300} value={form.topic} onChange={(e) => set({ topic: e.target.value })} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={channel.type === 'text' ? 'Кто может писать' : 'Кто может говорить'}>
            <Select value={form.send_min_role} onChange={(v) => set({ send_min_role: v })} options={ROLE_OPTIONS.map((o) => ({ ...o, label: `${o.label} и выше` }))} />
          </Field>
          {channel.type === 'text' ? (
            <Field label="Медленный режим">
              <Select
                value={String(form.slowmode_seconds)}
                onChange={(v) => set({ slowmode_seconds: Number(v) })}
                options={[
                  { value: '0', label: 'Выключен' },
                  { value: '5', label: '5 секунд' },
                  { value: '15', label: '15 секунд' },
                  { value: '60', label: '1 минута' },
                  { value: '300', label: '5 минут' },
                  { value: '3600', label: '1 час' },
                ]}
              />
            </Field>
          ) : (
            <Field label="Лимит участников">
              <Select
                value={String(form.user_limit ?? 0)}
                onChange={(v) => set({ user_limit: Number(v) || null })}
                options={[{ value: '0', label: 'Без лимита' }, ...[2, 3, 4, 5, 8, 10, 15, 25, 50, 99].map((n) => ({ value: String(n), label: String(n) }))]}
              />
            </Field>
          )}
        </div>

        <div className="rounded-xl bg-black/20 p-4">
          <label className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-white">
              <Lock className="h-4 w-4" /> Приватный канал
            </span>
            <Switch checked={form.is_private} onChange={(v) => set({ is_private: v, min_role: v && form.min_role === 'member' ? 'moderator' : form.min_role })} />
          </label>
          {form.is_private && (
            <div className="mt-4 space-y-3">
              <Field label="Доступ по роли" hint="Администраторы и владелец видят все каналы.">
                <Select
                  value={form.min_role}
                  onChange={(v) => set({ min_role: v })}
                  options={[
                    { value: 'member', label: 'Только выбранные участники' },
                    { value: 'moderator', label: 'Модераторы и выше' },
                    { value: 'admin', label: 'Администраторы и выше' },
                  ]}
                />
              </Field>
              <div>
                <span className="label">Участники с доступом</span>
                <input className="input mb-2" placeholder="Поиск участника" value={filter} onChange={(e) => setFilter(e.target.value)} />
                <div className="max-h-44 space-y-0.5 overflow-y-auto">
                  {visibleMembers.map((m) => (
                    <label key={m.user_id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-white/5">
                      <input
                        type="checkbox"
                        checked={allowed.includes(m.user_id)}
                        onChange={(e) => setAllowed(e.target.checked ? [...allowed, m.user_id] : allowed.filter((x) => x !== m.user_id))}
                      />
                      <Avatar userId={m.user_id} size={22} />
                      <span className="text-sm text-slate-200">{profiles[m.user_id]?.display_name ?? '…'}</span>
                      <span className="text-xs text-slate-500">{ROLE_LABEL[m.role]}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        {error && <div className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
      </div>
      <div className="flex items-center gap-2 bg-black/20 px-6 py-4">
        <button
          className="btn-ghost text-rose-300"
          onClick={() =>
            useUi.getState().openModal({
              type: 'confirm',
              title: `Удалить «${channel.name}»?`,
              body: 'Канал и вся его история будут удалены без возможности восстановления.',
              confirmLabel: 'Удалить',
              danger: true,
              onConfirm: async () => {
                await useServers.getState().deleteChannel(channelId);
                useUi.setState({ modalStack: [] });
              },
            })
          }
        >
          <Trash2 className="h-4 w-4" /> Удалить
        </button>
        <div className="flex-1" />
        <button className="btn-ghost" onClick={onClose}>
          Отмена
        </button>
        <button className="btn-primary" disabled={busy || !form.name.trim()} onClick={() => void save()}>
          {busy && <Spinner />} Сохранить
        </button>
      </div>
    </ModalShell>
  );
}
