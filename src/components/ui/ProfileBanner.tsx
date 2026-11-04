import { useEffect, useState } from 'react';
import { publicUrl } from '@/lib/supabase';

// Адрес привязан к файлу: при смене баннера загружается новый файл, поэтому кэш браузера не покажет старый.
export function ProfileBanner({ path, accent, className = '' }: { path?: string | null; accent?: string | null; className?: string }) {
  const url = publicUrl('profile-banners', path);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [url]);

  return (
    <div className={`relative aspect-[5/2] w-full overflow-hidden ${className}`} data-profile-banner>
      {/* Стандартный градиент виден и пока загружается изображение, и если его не удалось загрузить */}
      <div
        className={`absolute inset-0 ${accent ? '' : 'accent-bg'}`}
        style={accent ? { backgroundImage: `linear-gradient(135deg, ${accent} 0%, color-mix(in srgb, ${accent} 55%, #05060c) 100%)` } : undefined}
      />
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_85%_0%,rgba(255,255,255,0.22),transparent_60%),radial-gradient(90%_90%_at_0%_100%,rgba(5,6,12,0.45),transparent_70%)]" />
      {url && !failed && (
        <img
          key={url}
          src={url}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-500 ease-out ${loaded ? 'scale-100 opacity-100' : 'scale-[1.03] opacity-0'}`}
        />
      )}
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/15 to-transparent" />
    </div>
  );
}
