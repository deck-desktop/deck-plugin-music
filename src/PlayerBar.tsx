import { motion } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Music2, Volume2, Volume1, VolumeX, X } from "lucide-react";
import { usePlayer, usePlayerPosition } from "./player";
import { configRead, convertFileSrc } from "../shim/bridge.js";
import { useEffect, useRef, useState } from "react";

const fmt = (s: number) => {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

/**
 * The seek bar, in its own component because it is the only thing that reads the playback
 * position — which changes several times a second. Reading it in PlayerBar would re-render the
 * whole bar (artwork, title, every transport button) on each tick to move one slider.
 */
function SeekBar({ duration, onSeek }: { duration: number; onSeek: (t: number) => void }) {
  const position = usePlayerPosition();
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-text-muted">{fmt(position)}</span>
      <input type="range" min={0} max={duration || 0} step={0.1} value={position}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-[var(--accent)]" />
      <span className="w-8 shrink-0 text-[10px] tabular-nums text-text-muted">{fmt(duration)}</span>
    </div>
  );
}

export default function PlayerBar() {
  const p = usePlayer();
  // Placement setting: "fixed" (default) or "floating".
  const [placement, setPlacement] = useState<"fixed" | "floating">("fixed");
  useEffect(() => {
    const load = () => configRead("settings").then((t) => {
      try { const s = t.trim() ? JSON.parse(t) : {}; setPlacement(s.playerPlacement === "floating" ? "floating" : "fixed"); } catch { /* */ }
    }).catch(() => {});
    load();
    // Re-read when Settings writes the config (the watcher emits config-changed) so
    // switching placement updates live, without a restart.
    let un: (() => void) | undefined;
    listen<string[]>("config-changed", (e) => { if (e.payload.includes("settings")) load(); }).then((u) => (un = u));
    return () => un?.();
  }, []);

  if (!p.current) return null;

  const title = p.current.title || p.current.path.split(/[\\/]/).pop() || "";
  const controls = (
    <>
      <button onClick={() => p.setShuffle(!p.shuffle)} title="Shuffle"
        className="grid h-8 w-8 place-items-center rounded-md transition"
        style={{ color: p.shuffle ? "var(--accent)" : "var(--text-muted)" }}><Shuffle size={15} /></button>
      <button onClick={p.prev} title="Previous" className="grid h-8 w-8 place-items-center rounded-md text-text-secondary transition hover:text-text-primary"><SkipBack size={17} /></button>
      <button onClick={p.toggle} title={p.playing ? "Pause" : "Play"}
        className="grid h-9 w-9 place-items-center rounded-full text-white shadow-glow" style={{ background: "var(--accent-strong)" }}>
        {p.playing ? <Pause size={17} /> : <Play size={17} />}
      </button>
      <button onClick={p.next} title="Next" className="grid h-8 w-8 place-items-center rounded-md text-text-secondary transition hover:text-text-primary"><SkipForward size={17} /></button>
      <button onClick={p.cycleRepeat} title={`Repeat: ${p.repeat}`}
        className="grid h-8 w-8 place-items-center rounded-md transition"
        style={{ color: p.repeat !== "off" ? "var(--accent)" : "var(--text-muted)" }}>
        {p.repeat === "one" ? <Repeat1 size={15} /> : <Repeat size={15} />}
      </button>
    </>
  );

  const meta = (
    <div className="flex min-w-0 items-center gap-3">
      <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md" style={{ background: "var(--bg-elev)" }}>
        {p.current.artPath ? <img src={/^https?:/.test(p.current.artPath) ? p.current.artPath : convertFileSrc(p.current.artPath)} className="h-full w-full object-cover" alt="" /> : <Music2 size={16} className="text-text-muted" />}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-text-primary" title={title}>{title}</div>
        {p.current.artist && <div className="truncate text-[11px] text-text-muted">{p.current.artist}</div>}
      </div>
    </div>
  );

  const seek = <SeekBar duration={p.duration} onSeek={p.seek} />;

  if (placement === "floating") {
    return (
      <motion.div drag dragMomentum={false} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="no-drag absolute bottom-6 right-6 z-30 w-80 rounded-2xl p-3 shadow-card ring-1 ring-inset ring-white/10 backdrop-blur-xl"
        style={{ background: "var(--bg-card)" }}>
        <div className="mb-2 flex items-center justify-between">{meta}
          <div className="ml-2 flex shrink-0 items-center">
            <VolumeControl volume={p.volume} setVolume={p.setVolume} />
            <button onClick={p.clear} className="grid h-6 w-6 place-items-center rounded text-text-muted hover:text-text-primary" title="Close"><X size={13} /></button>
          </div>
        </div>
        <div className="mb-2">{seek}</div>
        <div className="flex items-center justify-center gap-1">{controls}</div>
      </motion.div>
    );
  }

  // Fixed bottom bar.
  return (
    <motion.div initial={{ y: 60 }} animate={{ y: 0 }}
      className="relative z-30 flex shrink-0 items-center gap-4 border-t border-subtle px-4 py-2 backdrop-blur-xl"
      style={{ background: "var(--bg-panel, var(--bg-card))" }}>
      <div className="w-56 shrink-0">{meta}</div>
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex items-center justify-center gap-1">{controls}</div>
        {seek}
      </div>
      <VolumeControl volume={p.volume} setVolume={p.setVolume} />
      <button onClick={p.clear} title="Close player"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition hover:bg-elev hover:text-text-primary"><X size={15} /></button>
    </motion.div>
  );
}

// Volume: an icon that reveals a vertical slider on hover. Click the icon to mute/unmute.
function VolumeControl({ volume, setVolume }: { volume: number; setVolume: (v: number) => void }) {
  const [open, setOpen] = useState(false);
  const prev = useRef(volume || 0.8);
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const toggleMute = () => {
    if (volume > 0) { prev.current = volume; setVolume(0); }
    else setVolume(prev.current || 0.8);
  };
  return (
    <div className="relative shrink-0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button onClick={toggleMute} title="Volume"
        className="grid h-8 w-8 place-items-center rounded-md text-text-muted transition hover:text-text-primary">
        <Icon size={16} />
      </button>
      {open && (
        // No gap to the icon (pt-2 keeps the visual spacing but stays hoverable) so moving
        // the cursor up to the slider doesn't cross a dead zone that dismisses the popup.
        <div className="absolute bottom-full left-1/2 z-40 -translate-x-1/2 pb-1 pt-2">
          <div className="rounded-lg p-2.5 shadow-card ring-1 ring-inset ring-white/10" style={{ background: "var(--bg-card)" }}>
            <input type="range" min={0} max={1} step={0.01} value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="h-24 w-1.5 cursor-pointer accent-[var(--accent)]"
              style={{ writingMode: "vertical-lr", direction: "rtl" }} />
          </div>
        </div>
      )}
    </div>
  );
}
