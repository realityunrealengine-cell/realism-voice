import { Download, FileText, Loader2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { signedUrl } from '@/lib/media';
import { formatSize } from '@/lib/format';
import type { Attachment } from '@/lib/types';
import { toast } from '@/stores/ui';

function useSigned(path: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    void signedUrl(path).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return { url, failed };
}

async function download(a: Attachment) {
  const url = await signedUrl(a.path);
  if (!url) return toast.error('Файл недоступен');
  if (window.rv) await window.rv.app.download(url, a.name);
}

function ImageAttachment({ a }: { a: Attachment }) {
  const { url, failed } = useSigned(a.path);
  const [zoom, setZoom] = useState(false);
  const w = a.width ?? 400;
  const h = a.height ?? 300;
  const scale = Math.min(1, 420 / w, 320 / h);
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
          <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">
            {failed ? 'Нет доступа к файлу' : <Loader2 className="h-5 w-5 animate-spin" />}
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
              <button className="icon-btn bg-white/10" onClick={(e) => { e.stopPropagation(); void download(a); }} title="Скачать">
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

function VideoAttachment({ a }: { a: Attachment }) {
  const { url } = useSigned(a.path);
  if (!url) return <FileAttachment a={a} />;
  return <video src={url} controls className="max-h-[320px] max-w-[420px] rounded-xl border border-white/5 bg-black" />;
}

function FileAttachment({ a, pending }: { a: Attachment; pending?: boolean }) {
  return (
    <div className="flex w-[360px] max-w-full items-center gap-3 rounded-xl border border-white/5 bg-black/25 px-3.5 py-3">
      <FileText className="h-8 w-8 shrink-0 text-indigo-300" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-sky-300">{a.name}</div>
        <div className="text-xs text-slate-500">{pending ? 'Загрузка…' : formatSize(a.size)}</div>
      </div>
      {!pending && (
        <button className="icon-btn" onClick={() => void download(a)} title="Скачать">
          <Download className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function Attachments({ list, pending }: { list: Attachment[]; pending?: boolean }) {
  if (!list.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {list.map((a, i) =>
        pending || !a.path ? (
          <FileAttachment key={i} a={a} pending />
        ) : a.mime.startsWith('image/') ? (
          <ImageAttachment key={a.path} a={a} />
        ) : a.mime.startsWith('video/') ? (
          <VideoAttachment key={a.path} a={a} />
        ) : (
          <FileAttachment key={a.path} a={a} />
        ),
      )}
    </div>
  );
}
