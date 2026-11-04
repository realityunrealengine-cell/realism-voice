// Фон приложения: мягкие цветные пятна под стеклянными панелями.
export function Backdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-base-950 via-base-900 to-base-950" />
      <div
        className="absolute -left-40 -top-40 h-[520px] w-[520px] animate-floaty rounded-full opacity-30 blur-[120px]"
        style={{ background: 'var(--a1)' }}
      />
      <div
        className="absolute -bottom-48 right-[-120px] h-[560px] w-[560px] animate-floaty rounded-full opacity-25 blur-[130px]"
        style={{ background: 'var(--a2)', animationDelay: '-7s' }}
      />
      <div
        className="absolute left-1/2 top-1/3 h-[300px] w-[300px] animate-floaty rounded-full opacity-10 blur-[100px]"
        style={{ background: '#22d3ee', animationDelay: '-12s' }}
      />
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            'radial-gradient(rgba(255,255,255,0.8) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />
    </div>
  );
}
