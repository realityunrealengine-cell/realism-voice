// Настройки «Сеть и P2P»: режимы доставки, прямые звонки, текущие соединения и измеренный трафик.
import { useEffect, useState } from 'react';
import { ArrowLeftRight, RefreshCw, Repeat2, Server, ShieldCheck } from 'lucide-react';
import { useSettings } from '@/stores/settings';
import { useVoice } from '@/stores/voice';
import { useAuth } from '@/stores/auth';
import { useNetStats, STAT_KINDS, sum, type StatKind, type Totals } from '@/stores/netStats';
import { useProfile } from '@/stores/profiles';
import { Select, Switch } from '@/components/ui/primitives';
import { formatSize } from '@/lib/format';
import { p2p } from '@/lib/p2p/integration';
import { p2pStore } from '@/lib/p2p/store';
import { TRANSPORT_UI } from '@/components/voice/TransportBadge';
import { Card, Row } from './parts';

const KIND_LABEL: Record<StatKind, { label: string; hint: string }> = {
  p2pMedia: { label: 'Звонки напрямую (P2P)', hint: 'Медиа WebRTC по прямому пути, без серверов' },
  relayMedia: { label: 'Звонки через TURN (Relay)', hint: 'Медиа через TURN-ретранслятор' },
  sfuMedia: { label: 'Звонки через Cloudflare SFU', hint: 'Медиа через сервер Cloudflare Realtime' },
  p2pMsg: { label: 'Сообщения напрямую (P2P)', hint: 'Зашифрованные кадры DataChannel, включая обмен ключами' },
  serverMsg: { label: 'Сообщения через сервер', hint: 'Полезная нагрузка JSON запросов и событий Supabase (без заголовков HTTP/WebSocket)' },
};

function StatsTable({ t }: { t: Totals }) {
  const direct = sum(t.p2pMedia) + sum(t.p2pMsg);
  const all = STAT_KINDS.reduce((n, k) => n + sum(t[k]), 0);
  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-2 font-medium">Путь</th>
            <th className="pb-2 text-right font-medium">Отправлено</th>
            <th className="pb-2 text-right font-medium">Получено</th>
          </tr>
        </thead>
        <tbody>
          {STAT_KINDS.map((k) => (
            <tr key={k} className="border-t border-white/5" title={KIND_LABEL[k].hint}>
              <td className="py-1.5 text-slate-300">{KIND_LABEL[k].label}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-200">{formatSize(t[k].sent)}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-200">{formatSize(t[k].received)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
        <ArrowLeftRight className="h-4 w-4 shrink-0" />
        <span>
          Не прошло через серверы: <b className="tabular-nums">{formatSize(direct)}</b>
          {all > 0 && <span className="text-emerald-300/70"> · {Math.round((direct / all) * 100)}% всего трафика</span>}
        </span>
      </div>
    </div>
  );
}

function PeerName({ id }: { id: string }) {
  const p = useProfile(id);
  return <>{p?.display_name ?? id.slice(0, 8)}</>;
}

function Connections() {
  const links = useNetStats((s) => s.links);
  const me = useAuth((s) => s.userId);
  const transport = useVoice((s) => s.transport);
  const target = useVoice((s) => s.target);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    await p2p.refreshLinkInfo();
    setBusy(false);
  };
  useEffect(() => {
    void p2p.refreshLinkInfo();
  }, []);
  const list = Object.entries(links);
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-white">Текущие соединения</h3>
        <button className="btn-ghost py-1" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> Обновить
        </button>
      </div>
      {target && transport && (
        <div className="mb-2 flex items-center gap-2 rounded-xl bg-black/25 px-3 py-2 text-sm">
          <span className="text-slate-400">Звонок «{target.name}»:</span>
          <span className={`rounded-md px-1.5 py-0.5 text-xs font-semibold ${TRANSPORT_UI[transport].cls}`}>{TRANSPORT_UI[transport].label}</span>
          <span className="text-xs text-slate-500">{TRANSPORT_UI[transport].hint}</span>
        </div>
      )}
      {list.length === 0 && !transport && <p className="text-sm text-slate-400">Прямых соединений сейчас нет.</p>}
      {list.map(([id, l]) => (
        <div key={id} className="flex items-center gap-3 border-t border-white/5 py-2 text-sm">
          {l.path === 'relay' ? <Repeat2 className="h-4 w-4 text-amber-300" /> : l.path === 'p2p' ? <ArrowLeftRight className="h-4 w-4 text-emerald-300" /> : <Server className="h-4 w-4 text-slate-400" />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-slate-200">
              Сообщения · {l.peer === me ? 'моё другое устройство' : <PeerName id={l.peer} />}
            </div>
            <div className="truncate text-xs text-slate-500">
              {l.state === 'connected' ? 'подключено' : l.state === 'connecting' ? 'подключение…' : 'нет связи'}
              {l.candidates ? ` · ICE ${l.candidates}` : ''}
              {l.rttMs != null ? ` · ${l.rttMs} мс` : ''}
            </div>
          </div>
          {l.encrypted && (
            <span title={l.encrypted} className="flex items-center gap-1 text-xs text-emerald-300/80">
              <ShieldCheck className="h-3.5 w-3.5" /> PQ
            </span>
          )}
        </div>
      ))}
    </Card>
  );
}

export function NetworkSection() {
  const prefs = useSettings((s) => s.prefs);
  const setPrefs = useSettings.getState().setPrefs;
  const totals = useNetStats((s) => s.totals);
  const session = useNetStats((s) => s.session);
  const since = useNetStats((s) => s.since);
  const me = useAuth((s) => s.userId);
  const [queued, setQueued] = useState<number | null>(null);
  const [scope, setScope] = useState<'session' | 'total'>('session');

  useEffect(() => {
    if (!me) return;
    let alive = true;
    const load = () => void p2pStore().outbox(me).then((o) => alive && setQueued(o.length)).catch(() => undefined);
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [me]);

  return (
    <div className="space-y-6">
      <Card>
        <h3 className="mb-1 font-semibold text-white">Звонки</h3>
        <Row
          title="Прямые звонки (P2P) в личных сообщениях"
          desc="Звук и видео идут напрямую между компьютерами. Если прямое соединение невозможно, звонок автоматически переходит на сервер без разрыва. Групповые голосовые каналы работают через сервер."
        >
          <Switch checked={prefs.callP2p} onChange={(v) => setPrefs({ callP2p: v })} />
        </Row>
        <Row
          title="Не раскрывать мой IP-адрес"
          desc="При прямом соединении собеседник видит ваш IP-адрес. С этим параметром прямые соединения идут только через TURN-ретранслятор (если он настроен на сервере), иначе — через Cloudflare SFU. P2P-сообщения при этом отключаются."
        >
          <Switch checked={prefs.p2pRelayOnly} onChange={(v) => setPrefs({ p2pRelayOnly: v })} />
        </Row>
        <p className="mt-2 text-xs text-slate-500">Изменения применяются к следующему звонку.</p>
      </Card>

      <Card>
        <h3 className="mb-1 font-semibold text-white">Личные сообщения</h3>
        <Row title="Режим доставки" desc="Текстовые сообщения в личных переписках. Файлы и голосовые сообщения всегда отправляются через сервер.">
          <div className="w-56">
            <Select
              value={prefs.messageMode}
              onChange={(v) => setPrefs({ messageMode: v })}
              options={[
                { value: 'server', label: 'Только сервер' },
                { value: 'auto', label: 'Auto: сначала P2P' },
                { value: 'p2p', label: 'Только P2P' },
              ]}
            />
          </div>
        </Row>
        <div className="mt-3 space-y-2 text-xs text-slate-400">
          {prefs.messageMode === 'server' && <p>Сообщения хранятся на сервере, как раньше: история доступна на всех устройствах.</p>}
          {prefs.messageMode === 'auto' && (
            <p>
              Если собеседник в сети и прямое соединение установлено, сообщение доставляется напрямую с подтверждением. Если подтверждения нет за 3 секунды или
              собеседник не в сети — сообщение уходит через сервер.
            </p>
          )}
          {prefs.messageMode === 'p2p' && (
            <p>
              Сообщения отправляются только напрямую. Если собеседник не в сети, сообщение ждёт в очереди на этом компьютере и будет доставлено, когда вы оба
              будете в сети.
            </p>
          )}
          {prefs.messageMode !== 'server' && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-amber-200/90">
              P2P-сообщения не хранятся на сервере: история есть только на устройствах собеседников и синхронизируется между ними при одновременном подключении.
              Шифрование: X25519 + ML-KEM-768 (FIPS 203) → AES-256-GCM поверх DTLS.
            </p>
          )}
          {prefs.p2pRelayOnly && prefs.messageMode !== 'server' && (
            <p className="text-amber-300">Включено «Не раскрывать мой IP-адрес» — P2P-сообщения не используются, работает доставка через сервер.</p>
          )}
          {queued !== null && queued > 0 && <p className="text-slate-300">В очереди P2P: {queued} операций ожидают получателя.</p>}
        </div>
      </Card>

      <Connections />

      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-semibold text-white">Статистика трафика</h3>
          <div className="w-44">
            <Select
              value={scope}
              onChange={setScope}
              options={[
                { value: 'session', label: 'Этот запуск' },
                { value: 'total', label: 'Всего' },
              ]}
            />
          </div>
        </div>
        <StatsTable t={scope === 'session' ? session : totals} />
        <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
          <span>
            Измерения getStats() WebRTC и размеры отправленных данных.{scope === 'total' && ` С ${new Date(since).toLocaleDateString('ru-RU')}.`}
          </span>
          {scope === 'total' && (
            <button className="text-slate-400 hover:text-white hover:underline" onClick={() => useNetStats.getState().reset()}>
              Сбросить
            </button>
          )}
        </div>
      </Card>
    </div>
  );
}
