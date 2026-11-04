import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { ImagePlus, Move, Trash2 } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/ui';
import { supabase } from '@/lib/supabase';
import { errorMessage } from '@/lib/errors';
import { uploadPublicImage } from '@/lib/media';
import { BANNER_MAX_ZOOM, BANNER_MIME, bannerFileError, clampCrop, cropSize, renderBanner, type BannerCrop } from '@/lib/banner';
import { ModalShell, Slider, Spinner } from '@/components/ui/primitives';
import { ProfileBanner } from '@/components/ui/ProfileBanner';

const BUCKET = 'profile-banners';

interface Source {
  url: string;
  image: HTMLImageElement;
}

function saveError(e: unknown): string {
  const message = errorMessage(e);
  if (/bucket not found|banner_path/i.test(message)) return 'Хранилище баннеров на сервере ещё не настроено';
  return message;
}

export function BannerEditor({ onClose }: { onClose: () => void }) {
  const profile = useAuth((s) => s.profile)!;
  const [source, setSource] = useState<Source | null>(null);
  const [crop, setCrop] = useState<BannerCrop>({ cx: 0, cy: 0, zoom: 1 });
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; crop: BannerCrop } | null>(null);
  const cancelled = useRef(false);

  useEffect(() => () => {
    if (source) URL.revokeObjectURL(source.url);
  }, [source]);

  const choose = (file: File) => {
    const invalid = bannerFileError(file);
    if (invalid) return setError(invalid);
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      setError(null);
      setCrop({ cx: image.naturalWidth / 2, cy: image.naturalHeight / 2, zoom: 1 });
      setSource({ url, image });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError('Файл повреждён или не является изображением');
    };
    image.src = url;
  };

  const update = (next: BannerCrop) => {
    if (source) setCrop(clampCrop(source.image.naturalWidth, source.image.naturalHeight, next));
  };

  const pixelsPerPoint = () => {
    const frame = frameRef.current;
    if (!frame || !source) return 1;
    return cropSize(source.image.naturalWidth, source.image.naturalHeight, crop.zoom).w / frame.clientWidth;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!source) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, crop };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const k = pixelsPerPoint();
    update({ ...drag.current.crop, cx: drag.current.crop.cx - (e.clientX - drag.current.x) * k, cy: drag.current.crop.cy - (e.clientY - drag.current.y) * k });
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (source) update({ ...crop, zoom: crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = pixelsPerPoint() * 12;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (!d || !source) return;
    e.preventDefault();
    update({ ...crop, cx: crop.cx + d[0], cy: crop.cy + d[1] });
  };

  const save = async () => {
    if (!source) return;
    setBusy('save');
    setError(null);
    cancelled.current = false;
    let uploaded: string | null = null;
    try {
      const file = await renderBanner(source.image, crop);
      uploaded = await uploadPublicImage(BUCKET, profile.id, file);
      if (cancelled.current) {
        await supabase.storage.from(BUCKET).remove([uploaded]);
        return;
      }
      const old = profile.banner_path;
      await useAuth.getState().updateProfile({ banner_path: uploaded });
      uploaded = null;
      if (old) void supabase.storage.from(BUCKET).remove([old]);
      toast.success('Баннер обновлён');
      onClose();
    } catch (e) {
      // Профиль не изменился: загруженный файл никому не нужен
      if (uploaded) void supabase.storage.from(BUCKET).remove([uploaded]);
      if (!cancelled.current) setError(saveError(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const old = profile.banner_path;
    if (!old) return;
    setBusy('delete');
    setError(null);
    try {
      await useAuth.getState().updateProfile({ banner_path: null });
      void supabase.storage.from(BUCKET).remove([old]);
      toast.success('Баннер удалён');
      onClose();
    } catch (e) {
      setError(saveError(e));
    } finally {
      setBusy(null);
    }
  };

  // Загрузка не отменяется на полпути, но её результат не применится, а файл будет удалён
  const cancel = () => {
    cancelled.current = true;
    onClose();
  };

  const size = source ? cropSize(source.image.naturalWidth, source.image.naturalHeight, crop.zoom) : null;
  return (
    <ModalShell open onClose={cancel} width="max-w-2xl" title="Баннер профиля" subtitle="Выберите изображение и настройте видимую часть">
      <div className="space-y-4 px-6 pb-5 pt-3">
        {source && size ? (
          <div
            ref={frameRef}
            data-banner-frame
            tabIndex={0}
            role="application"
            aria-label="Положение баннера: перетащите изображение или используйте стрелки"
            className="relative aspect-[5/2] w-full cursor-grab touch-none select-none overflow-hidden rounded-xl bg-black/40 outline-none ring-1 ring-white/10 focus-visible:ring-2 focus-visible:ring-[color:var(--a2)] active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
          >
            <img
              src={source.url}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none"
              style={{
                width: `${(source.image.naturalWidth / size.w) * 100}%`,
                height: `${(source.image.naturalHeight / size.h) * 100}%`,
                left: `${(-(crop.cx - size.w / 2) / size.w) * 100}%`,
                top: `${(-(crop.cy - size.h / 2) / size.h) * 100}%`,
              }}
            />
            <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-slate-200 backdrop-blur-sm">
              <Move className="h-3 w-3" /> Перетащите, чтобы выбрать область
            </div>
          </div>
        ) : (
          <ProfileBanner path={profile.banner_path} accent={profile.accent_color} className="rounded-xl ring-1 ring-white/10" />
        )}

        {source && (
          <div>
            <span className="label">Масштаб</span>
            <Slider value={crop.zoom} min={1} max={BANNER_MAX_ZOOM} step={0.01} onChange={(zoom) => update({ ...crop, zoom })} format={(v) => `${Math.round(v * 100)}%`} />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-ghost" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
            <ImagePlus className="h-4 w-4" /> {source ? 'Выбрать другое изображение' : 'Выбрать изображение'}
          </button>
          <span className="text-xs text-slate-500">PNG, JPG, JPEG или WebP, до 5 МБ</span>
          <input
            ref={fileRef}
            type="file"
            accept={BANNER_MIME.join(',')}
            hidden
            data-banner-input
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) choose(f);
              e.target.value = '';
            }}
          />
        </div>
        {error && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
      </div>
      <div className="flex items-center gap-2 bg-black/20 px-6 py-4">
        {profile.banner_path && (
          <button className="btn-ghost text-rose-300" disabled={busy !== null} onClick={() => void remove()}>
            {busy === 'delete' ? <Spinner /> : <Trash2 className="h-4 w-4" />} Удалить баннер
          </button>
        )}
        <div className="flex-1" />
        <button className="btn-ghost" onClick={cancel}>
          Отмена
        </button>
        <button className="btn-primary" disabled={!source || busy !== null} onClick={() => void save()}>
          {busy === 'save' && <Spinner />} Сохранить
        </button>
      </div>
    </ModalShell>
  );
}
