// Фирменный знак Realism Voice (1.3.0): неоновая «R» с облаком речи и аудиоволной.
// Растровый логотип 256×256 (из build/logo-source.png, см. scripts/generate-icons.mjs).
import logoUrl from '@/assets/logo.png';

export function LogoMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img src={logoUrl} width={size} height={size} alt="" aria-hidden draggable={false} className={`select-none ${className}`} style={{ width: size, height: size }} />;
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <LogoMark size={44} />
      <div className="leading-tight">
        <div className="text-xl font-bold tracking-tight text-white">
          Realism <span className="accent-text">Voice</span>
        </div>
        <div className="text-xs text-slate-400">Голос без границ</div>
      </div>
    </div>
  );
}
