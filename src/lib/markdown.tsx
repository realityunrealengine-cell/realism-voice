// Безопасный рендер текста сообщений: **жирный**, *курсив*, __подчёркнутый__, ~~зачёркнутый~~,
// `код`, ```блоки кода```, ||спойлеры||, ссылки и @упоминания. Без dangerouslySetInnerHTML.
import { useState, type ReactNode } from 'react';

interface Ctx {
  mentionLookup: (username: string) => { id: string; label: string } | null;
  onMention: (id: string, e: React.MouseEvent) => void;
  onLink: (url: string) => void;
}

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(~~[^~\n]+~~)|(\|\|[^|\n]+\|\|)|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(realismvoice:\/\/invite\/[A-Za-z0-9]{6,16})|(@(?:everyone|here)\b)|(@[A-Za-z0-9_.]{3,32})/g;

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      onClick={() => setShown(true)}
      className={`cursor-pointer rounded px-0.5 transition ${shown ? 'bg-white/10' : 'bg-slate-600 text-transparent'}`}
    >
      {children}
    </span>
  );
}

function inline(text: string, ctx: Ctx, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${keyPrefix}-${i++}`;
    if (m[1]) out.push(<code key={k} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-pink-200">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k} className="font-semibold text-white">{inline(tok.slice(2, -2), ctx, k)}</strong>);
    else if (m[3]) out.push(<u key={k}>{inline(tok.slice(2, -2), ctx, k)}</u>);
    else if (m[4]) out.push(<em key={k}>{inline(tok.slice(1, -1), ctx, k)}</em>);
    else if (m[5]) out.push(<s key={k}>{inline(tok.slice(2, -2), ctx, k)}</s>);
    else if (m[6]) out.push(<Spoiler key={k}>{tok.slice(2, -2)}</Spoiler>);
    else if (m[7] || m[8])
      out.push(
        <a
          key={k}
          href={tok}
          onClick={(e) => {
            e.preventDefault();
            ctx.onLink(tok);
          }}
          className="break-all text-sky-300 hover:underline"
        >
          {tok}
        </a>,
      );
    else if (m[9]) out.push(<span key={k} className="mention-chip">{tok}</span>);
    else if (m[10]) {
      const user = ctx.mentionLookup(tok.slice(1).toLowerCase());
      out.push(
        user ? (
          <span key={k} className="mention-chip cursor-pointer hover:underline" onClick={(e) => ctx.onMention(user.id, e)}>
            @{user.label}
          </span>
        ) : (
          tok
        ),
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMessage(content: string, ctx: Ctx): ReactNode[] {
  const parts = content.split(/```(?:[a-zA-Z0-9]+\n)?([\s\S]*?)```/g);
  const out: ReactNode[] = [];
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      out.push(
        <pre key={`b${idx}`} className="selectable my-1 overflow-x-auto rounded-lg border border-white/5 bg-black/40 p-3 font-mono text-[0.85em] text-slate-200">
          {part.replace(/\n$/, '')}
        </pre>,
      );
    } else if (part) {
      const lines = part.split('\n');
      lines.forEach((line, li) => {
        if (line.startsWith('> ')) {
          out.push(
            <div key={`q${idx}-${li}`} className="my-0.5 border-l-4 border-white/20 pl-3 text-slate-300">
              {inline(line.slice(2), ctx, `q${idx}-${li}`)}
            </div>,
          );
        } else {
          out.push(...inline(line, ctx, `l${idx}-${li}`));
          if (li < lines.length - 1) out.push(<br key={`br${idx}-${li}`} />);
        }
      });
    }
  });
  return out;
}

export function isEmojiOnly(content: string): boolean {
  const t = content.trim();
  if (!t || t.length > 24) return false;
  return /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(t);
}
