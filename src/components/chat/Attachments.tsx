import {
  AlertTriangle, Archive, Download, File as FileIcon, FileAudio, FileCode, FileImage, FileText, FileVideo, FolderDown, Folder,
  Loader2, Pause, Play, RotateCw, ShieldAlert, WifiOff, X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { signedUrl } from '@/lib/media';
import { formatSize, plural } from '@/lib/format';
import type { Attachment } from '@/lib/types';
import { toast, useUi } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { bindDownloadKey, formatSpeed, percent, useTransfers, type UploadView } from '@/stores/transfers';
import { fileExtension, isDangerousFile } from '../../../electron/fileRisk';

/** Изображения больше этого размера не загружаются для превью автоматически (бережём трафик бесплатного тарифа) */
const AUTO_PREVIEW_MAX = 5 * 1024 * 1024;

function useSigned(path: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !enabled) return;
    let alive = true;
    signedUrl(path)
      .then((u) => {
        if (!alive) return;
        if (u) setUrl(u);
        else setFailed('Нет доступа к файлу');
      })
      .catch((e: Error) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [path, enabled]);
  return { url, failed };
}

function typeIcon(a: Pick<Attachment, 'name' | 'mime' | 'kind'>) {
  if (a.kind === 'folder') return Folder;
  const ext = fileExtension(a.name);
  if (a.mime.startsWith('image/')) return FileImage;
  if (a.mime.startsWith('video/')) return FileVideo;
  if (a.mime.startsWith('audio/')) return FileAudio;
  if (['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz'].includes(ext)) return Archive;
  if (['js', 'ts', 'tsx', 'py', 'cs', 'cpp', 'c', 'h', 'java', 'json', 'xml', 'yml', 'yaml', 'sql', 'sh', 'ps1', 'bat'].includes(ext)) return FileCode;
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'rtf', 'odt'].includes(ext)) return FileText;
  return FileIcon;
}

function typeLabel(a: Attachment): string {
  if (a.kind === 'folder') return 'Папка';
  const ext = fileExtension(a.name);
  return ext ? ext.toUpperCase() : 'Файл';
}

/** Ключ карточки → идентификатор задачи main-процесса (для отмены) */
const keyToId = new Map<string, string>();

async function startDownload(a: Attachment, extract: boolean) {
  const key = `${a.path}${extract ? '#folder' : ''}`;
  const tr = useTransfers.getState();
  const busy = tr.downloads[key];
  if (busy && (busy.phase === 'downloading' || busy.phase === 'extracting' || busy.phase === 'choosing')) return;
  tr.setDownload(key, { name: a.name, phase: 'choosing', transferred: 0, total: a.size, bytesPerSecond: 0, error: null, savedPath: null });
  let url: string | null;
  try {
    url = await signedUrl(a.path);
  } catch (e) {
    const msg = (e as Error).message;
    tr.setDownload(key, { phase: 'error', error: msg });
    toast.error('Скачивание недоступно', msg);
    return;
  }
  if (!url) {
    tr.setDownload(key, { phase: 'error', error: 'Нет доступа к файлу' });
    return;
  }
  if (!window.rv?.files) {
    tr.removeDownload(key);
    await window.rv?.app.download(url, a.name);
    return;
  }
  const id = crypto.randomUUID();
  bindDownloadKey(id, key);
  keyToId.set(key, id);
  const name = extract ? a.name : a.kind === 'folder' ? `${a.name}.zip` : a.name;
  await window.rv.files.download({ id, url, name, extractFolder: extract, size: a.size });
}

async function openSaved(path: string, name: string) {
  const r = await window.rv?.files.openDownloaded(path, false);
  if (r === 'missing') toast.error('Файл не найден', 'Возможно, его переместили или удалили');
  if (r === 'needs-confirmation') {
    useUi.getState().openModal({
      type: 'confirm',
      title: `Открыть «${name}»?`,
      body: (
        <div className="space-y-2">
          <p>Это исполняемый файл или файл, который может запустить программу на вашем компьютере.</p>
          <p className="text-amber-200">Открывайте его, только если доверяете отправителю и ожидали этот файл. Windows дополнительно проверит его фильтром SmartScreen.</p>
        </div>
      ),
      confirmLabel: 'Открыть всё равно',
      danger: true,
      onConfirm: async () => {
        await window.rv?.files.openDownloaded(path, true);
      },
    });
  }
}

function Progress({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'warn' | 'bad' }) {
  const color = tone === 'bad' ? 'bg-rose-400' : tone === 'warn' ? 'bg-amber-400' : 'accent-bg';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <motion.div className={`h-full rounded-full ${color}`} initial={false} animate={{ width: `${value}%` }} transition={{ duration: 0.25 }} />
    </div>
  );
}

function DownloadState({ dkey, a, extract }: { dkey: string; a: Attachment; extract: boolean }) {
  const d = useTransfers((s) => s.downloads[dkey]);
  if (!d || d.phase === 'cancelled') return null;
  if (d.phase === 'done' && d.savedPath) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-emerald-300">{extract ? 'Папка сохранена' : 'Сохранено'}</span>
        {!extract && (
          <button className="rounded-md bg-white/10 px-2 py-1 text-slate-100 hover:bg-white/15" onClick={() => void openSaved(d.savedPath!, a.name)}>
            Открыть
          </button>
        )}
        <button className="rounded-md bg-white/10 px-2 py-1 text-slate-100 hover:bg-white/15" onClick={() => void window.rv?.files.showInFolder(d.savedPath!)}>
          Показать в папке
        </button>
        {d.error && <span className="w-full text-amber-300">{d.error}</span>}
      </div>
    );
  }
  if (d.phase === 'error') {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-rose-300">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 flex-1">{d.error}</span>
        <button className="text-sky-300 hover:underline" onClick={() => void startDownload(a, extract)}>
          Повторить
        </button>
      </div>
    );
  }
  const p = d.phase === 'extracting' ? percent(d.transferred, d.total) : percent(d.transferred, d.total || a.size);
  return (
    <div className="mt-2 space-y-1">
      <Progress value={d.phase === 'choosing' ? 0 : p} />
      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
        <span>
          {d.phase === 'choosing'
            ? 'Выбор места сохранения…'
            : d.phase === 'extracting'
              ? `Распаковка папки… ${p}%`
              : `${p}% · ${formatSize(d.transferred)} из ${formatSize(d.total || a.size)} ${formatSpeed(d.bytesPerSecond)}`}
        </span>
        {d.phase === 'downloading' && (
          <button className="text-slate-400 hover:text-white" title="Отменить" onClick={() => void window.rv?.files.cancelDownload(keyToId.get(dkey) ?? '')}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function FileCard({ a }: { a: Attachment }) {
  const Icon = typeIcon(a);
  const dangerous = a.kind !== 'folder' && isDangerousFile(a.name);
  const dkey = a.path;
  const fkey = `${a.path}#folder`;
  const isFolder = a.kind === 'folder';
  return (
    <div className="w-[380px] max-w-full rounded-xl border border-white/5 bg-black/25 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${isFolder ? 'bg-amber-400/10 text-amber-300' : dangerous ? 'bg-rose-500/10 text-rose-300' : 'bg-indigo-400/10 text-indigo-300'}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-sky-300" title={a.name}>
            {a.name}
          </div>
          <div className="truncate text-xs text-slate-500">
            {isFolder && a.folder
              ? `${a.folder.files} ${plural(a.folder.files, 'файл', 'файла', 'файлов')}${a.folder.dirs ? ` · ${a.folder.dirs} ${plural(a.folder.dirs, 'папка', 'папки', 'папок')}` : ''} · ${formatSize(a.folder.bytes)} (архив ${formatSize(a.size)})`
              : `${typeLabel(a)} · ${formatSize(a.size)}`}
          </div>
        </div>
        {isFolder ? (
          <>
            <button className="icon-btn" title="Скачать папку (с сохранением структуры)" onClick={() => void startDownload(a, true)}>
              <FolderDown className="h-4 w-4" />
            </button>
            <button className="icon-btn" title="Скачать ZIP-архив" onClick={() => void startDownload(a, false)}>
              <Download className="h-4 w-4" />
            </button>
          </>
        ) : (
          <button className="icon-btn" title="Скачать" onClick={() => void startDownload(a, false)}>
            <Download className="h-4 w-4" />
          </button>
        )}
      </div>
      {dangerous && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-amber-200/80">
          <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" /> Исполняемый файл. Приложение не запускает его само; открывайте, только если доверяете отправителю.
        </div>
      )}
      <DownloadState dkey={dkey} a={a} extract={false} />
      {isFolder && <DownloadState dkey={fkey} a={a} extract />}
    </div>
  );
}

function ImageAttachment({ a }: { a: Attachment }) {
  const [requested, setRequested] = useState(a.size <= AUTO_PREVIEW_MAX);
  const { url, failed } = useSigned(a.path, requested);
  const [zoom, setZoom] = useState(false);
  const w = a.width ?? 400;
  const h = a.height ?? 300;
  const scale = Math.min(1, 420 / w, 320 / h);
  if (!requested) {
    return (
      <button
        className="flex w-[380px] max-w-full items-center gap-3 rounded-xl border border-white/5 bg-black/25 px-3.5 py-3 text-left hover:bg-black/35"
        onClick={() => setRequested(true)}
      >
        <FileImage className="h-8 w-8 shrink-0 text-indigo-300" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-sky-300">{a.name}</span>
          <span className="text-xs text-slate-500">{formatSize(a.size)} · нажмите, чтобы показать</span>
        </span>
      </button>
    );
  }
  return (
    <>
      <div
        className="relative cursor-zoom-in overflow-hidden rounded-xl border border-white/5 bg-black/30"
        style={{ width: Math.round(w * scale), height: Math.round(h * scale) }}
        onClick={() => url && setZoom(true)}
      >
        {url ? (
          <img src={url} alt={a.name} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-slate-500">
            {failed ?? <Loader2 className="h-5 w-5 animate-spin" />}
          </div>
        )}
      </div>
      <AnimatePresence>
        {zoom && url && (
          <motion.div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-10 backdrop-blur"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setZoom(false)}
          >
            <motion.img initial={{ scale: 0.95 }} animate={{ scale: 1 }} src={url} alt={a.name} className="max-h-full max-w-full rounded-lg shadow-2xl" />
            <div className="absolute right-6 top-6 flex gap-2">
              <button className="icon-btn bg-white/10" onClick={(e) => { e.stopPropagation(); void startDownload(a, false); }} title="Скачать">
                <Download className="h-4 w-4" />
              </button>
              <button className="icon-btn bg-white/10" onClick={() => setZoom(false)} title="Закрыть">
                <X className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

const PLAYABLE_VIDEO = ['video/mp4', 'video/webm', 'video/ogg'];

function VideoAttachment({ a }: { a: Attachment }) {
  const [requested, setRequested] = useState(false);
  const { url, failed } = useSigned(a.path, requested);
  if (!PLAYABLE_VIDEO.includes(a.mime)) return <FileCard a={a} />;
  if (!requested || !url) {
    return (
      <div className="w-[380px] max-w-full">
        <button
          className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-white/5 bg-black/40 text-slate-300 hover:bg-black/50"
          onClick={() => setRequested(true)}
        >
          {requested && !failed ? <Loader2 className="h-8 w-8 animate-spin" /> : <Play className="h-9 w-9" />}
          <span className="max-w-[90%] truncate text-sm">{a.name}</span>
          <span className="text-xs text-slate-500">{failed ?? `${formatSize(a.size)} · воспроизвести`}</span>
        </button>
        <div className="mt-1 flex justify-end">
          <button className="flex items-center gap-1 text-xs text-slate-400 hover:text-white" onClick={() => void startDownload(a, false)}>
            <Download className="h-3.5 w-3.5" /> Скачать
          </button>
        </div>
        <DownloadState dkey={a.path} a={a} extract={false} />
      </div>
    );
  }
  return <video src={url} controls autoPlay className="max-h-[320px] max-w-[420px] rounded-xl border border-white/5 bg-black" />;
}

function UploadCard({ a, u }: { a: Attachment; u: UploadView | undefined }) {
  const phase = u?.phase ?? 'queued';
  const Icon = typeIcon({ name: a.name, mime: a.mime, kind: a.kind });
  const total = u?.total || a.size;
  const p = percent(u?.transferred ?? 0, total);
  const msgs = useMessages.getState();
  const canPause = phase === 'uploading' || phase === 'waiting-network';
  const label = (() => {
    switch (phase) {
      case 'queued':
        return 'В очереди';
      case 'preparing':
        return a.kind === 'folder'
          ? `Подготовка папки${u?.totalFiles ? `: ${u.packedFiles ?? 0} из ${u.totalFiles} ${plural(u.totalFiles, 'файла', 'файлов', 'файлов')}` : '…'}`
          : 'Подготовка…';
      case 'reserving':
        return 'Проверка квоты…';
      case 'uploading':
      case 'sending':
        return `${p}% · ${formatSize(u?.transferred ?? 0)} из ${formatSize(total)} ${formatSpeed(u?.bytesPerSecond ?? 0)}`;
      case 'waiting-network':
        return `Нет соединения — продолжится автоматически (${p}%)`;
      case 'paused':
        return `Пауза · ${p}%`;
      case 'done':
        return 'Загружено';
      case 'error':
        return u?.error ?? 'Ошибка загрузки';
      default:
        return '';
    }
  })();
  return (
    <div className="w-[380px] max-w-full rounded-xl border border-white/5 bg-black/25 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-slate-300">
          {phase === 'waiting-network' ? <WifiOff className="h-5 w-5 text-amber-300" /> : <Icon className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-200">{a.name}</div>
          <div className={`truncate text-xs ${phase === 'error' ? 'text-rose-300' : phase === 'waiting-network' ? 'text-amber-300' : 'text-slate-500'}`}>{label}</div>
        </div>
        {u && canPause && a._uploadId && (
          <button className="icon-btn" title="Пауза" onClick={() => void msgs.pauseUpload(a._uploadId!)}>
            <Pause className="h-4 w-4" />
          </button>
        )}
        {u && phase === 'paused' && a._uploadId && (
          <button className="icon-btn" title="Продолжить" onClick={() => void msgs.resumeUpload(a._uploadId!)}>
            <RotateCw className="h-4 w-4" />
          </button>
        )}
        {u && phase !== 'done' && a._uploadId && (
          <button className="icon-btn" title="Отменить" onClick={() => void msgs.cancelUpload(a._uploadId!)}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {phase !== 'error' && phase !== 'queued' && (
        <div className="mt-2">
          <Progress value={phase === 'preparing' && u?.totalFiles ? percent(u.packedFiles ?? 0, u.totalFiles) : p} tone={phase === 'waiting-network' || phase === 'paused' ? 'warn' : 'accent'} />
        </div>
      )}
    </div>
  );
}

function PendingAttachment({ a }: { a: Attachment }) {
  const u = useTransfers((s) => (a._uploadId ? s.uploads[a._uploadId] : undefined));
  return <UploadCard a={a} u={u} />;
}

export function Attachments({ list, pending }: { list: Attachment[]; pending?: boolean }) {
  if (!list.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {list.map((a, i) =>
        pending || !a.path ? (
          <PendingAttachment key={a._uploadId ?? i} a={a} />
        ) : a.kind !== 'folder' && a.mime.startsWith('image/') && a.mime !== 'image/svg+xml' ? (
          <ImageAttachment key={a.path} a={a} />
        ) : a.kind !== 'folder' && a.mime.startsWith('video/') ? (
          <VideoAttachment key={a.path} a={a} />
        ) : (
          <FileCard key={a.path} a={a} />
        ),
      )}
    </div>
  );
}
