// The player as a footer readout (Settings › Music › Footer): play/pause and the track's title in
// Deck's footer, and the player itself as the readout's menu, the way the memory readout opens its
// breakdown. Nothing over the page, nothing along the bottom: the footer is all it takes.
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Music2, Pause, Play, X } from "lucide-react";
import { StatusItem, StatusPopover } from "../shim/ui.js";
import { convertFileSrc } from "../shim/bridge.js";
import { usePlayer, usePlayerPosition } from "./player";
import { Controls, nowPlaying, titleOf, volumeIcon } from "./PlayerBar";
import ListenButton from "./ListenButton";
import { usePlacement } from "./placement";

/** Space between the title and its next copy as it goes round. */
const GAP = 32;

/** The title in the footer, in a fixed width (the footer does not jump as titles change), going
 *  round while the track plays: two copies one after the other, the second as far after the first
 *  as the box is wide at least, so a short title loops as cleanly as a long one. Stopped while
 *  paused, and for reduced motion. Measured in an effect as the title or the room changes. */
function Marquee({ text, moving }: { text: string; moving: boolean }) {
  const box = useRef<HTMLSpanElement>(null), one = useRef<HTMLSpanElement>(null);
  // How far one turn moves (the title and the space after it), and the title's own width.
  const [size, setSize] = useState({ shift: 0, w: 0 });
  const still = useReducedMotion();
  useEffect(() => {
    const measure = () => {
      const b = box.current, o = one.current;
      if (b && o) setSize({ shift: Math.max(o.offsetWidth + GAP, b.clientWidth), w: o.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [text]);
  const go = size.shift > 0 && moving && !still;
  return (
    <span ref={box} className="block w-[160px] overflow-hidden [[data-footer-tight]_&]:hidden"
      // Faded at its edges, so the words come and go rather than being cut.
      style={{ maskImage: "linear-gradient(90deg, transparent, #000 10px, #000 calc(100% - 14px), transparent)" }}>
      <motion.span className="inline-flex whitespace-nowrap" animate={{ x: go ? [0, -size.shift] : 0 }}
        transition={go ? { duration: size.shift / 28, ease: "linear", repeat: Infinity } : { duration: 0.4 }}>
        <span ref={one}>{text}</span>
        <span aria-hidden style={{ paddingLeft: size.shift - size.w }}>{text}</span>
      </motion.span>
    </span>
  );
}
const fmt = (s: number) => (!s || !isFinite(s) ? "0:00" : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`);
const iconBtn = "grid size-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-white/[0.06] hover:text-text-primary";

/** A thin bar, filled to `value` of `max`, with a small knob; a range input over it, unseen, does the dragging. */
function Slim({ value, max, onChange, label }: { value: number; max: number; onChange: (v: number) => void; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="group relative flex h-4 w-full items-center">
      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--text-primary) 14%, transparent)" }}>
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
      </div>
      <div className="pointer-events-none absolute size-2.5 rounded-full bg-[var(--text-primary)] shadow transition-transform group-hover:scale-125"
        style={{ left: `calc(${pct}% - 5px)` }} />
      <input type="range" min={0} max={max || 0} step={max > 10 ? 0.1 : 0.01} value={value} aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="absolute inset-0 w-full cursor-pointer opacity-0" />
    </div>
  );
}

/** Where the track is: its own component, the only part that redraws as it plays. */
function Seek({ duration, onSeek }: { duration: number; onSeek: (t: number) => void }) {
  const position = usePlayerPosition();
  return (
    <div>
      <Slim value={position} max={duration} onChange={onSeek} label="Seek" />
      <div className="mt-0.5 flex justify-between text-[10.5px] tabular-nums text-text-muted">
        <span>{fmt(position)}</span><span>{fmt(duration)}</span>
      </div>
    </div>
  );
}

export default function FooterPlayer() {
  const p = usePlayer();
  const placement = usePlacement();
  const [open, setOpen] = useState(false);
  const prev = useRef(p.volume || 0.8);
  if (placement !== "footer" || (!p.current && !p.listening)) return null;
  const cur = nowPlaying(p), title = titleOf(cur);
  const Vol = volumeIcon(p.volume);
  const mute = () => { if (p.volume > 0) { prev.current = p.volume; p.setVolume(0); } else p.setVolume(prev.current || 0.8); };
  const art = cur.artPath && (/^https?:/.test(cur.artPath) ? cur.artPath : convertFileSrc(cur.artPath));

  return (
    <StatusPopover open={open} onToggle={() => setOpen((v) => !v)} onClose={() => setOpen(false)} width="w-80"
      item={
        <div className={"flex items-center rounded-[4px]" + (open ? " bg-white/[0.08]" : "")}>
          {/* Play/pause straight from the footer, without opening the menu. */}
          <span onClick={(e) => { e.stopPropagation(); p.toggle(); }}>
            <StatusItem icon={p.playing ? <Pause /> : <Play />} color={p.playing ? "var(--accent)" : "var(--text-secondary)"} label=""
              title={p.playing ? "Pause" : "Play"} />
          </span>
          {/* StatusItem's look, with the title going round in place of its plain label. */}
          <button title={`${title}${cur.artist ? ` · ${cur.artist}` : ""}. Click for the player`}
            className="flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-[4px] px-2 text-[11.5px] text-text-secondary transition-colors hover:bg-white/[0.06]">
            <Music2 size={13} className="shrink-0" />
            <Marquee text={title} moving={p.playing} />
          </button>
        </div>
      }>
      <div className="flex flex-col gap-3 p-3.5">
        {/* The track: its cover, the title over up to two lines, the artist; listen together and close beside it. */}
        <div className="flex items-start gap-3">
          <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg" style={{ background: "var(--bg-elev)" }}>
            {art ? <img src={art} className="size-full object-cover" alt="" /> : <Music2 size={20} className="text-text-muted" />}
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            {p.listening && <div className="mb-0.5 text-[10.5px] font-medium text-[var(--accent)]">Listening together</div>}
            <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-text-primary" title={title}>{title}</div>
            {cur.artist && <div className="mt-0.5 truncate text-[11.5px] text-text-muted">{cur.artist}</div>}
          </div>
          <div className="-mr-1.5 -mt-1 flex shrink-0 items-center">
            <ListenButton small />
            <button onClick={() => { setOpen(false); p.clear(); }} title={p.listening ? "Leave" : "Close player"} className={iconBtn}><X size={14} /></button>
          </div>
        </div>
        <Seek duration={p.duration} onSeek={p.seek} />
        <div className="-mt-1 flex items-center justify-center gap-1"><Controls p={p} /></div>
        <div className="flex items-center gap-2">
          <button onClick={mute} title={p.volume === 0 ? "Unmute" : "Mute"} className={iconBtn + " -ml-1.5"}><Vol size={14} /></button>
          <Slim value={p.volume} max={1} onChange={p.setVolume} label="Volume" />
        </div>
      </div>
    </StatusPopover>
  );
}
