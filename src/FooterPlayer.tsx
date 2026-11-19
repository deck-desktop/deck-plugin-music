// The player as a footer readout (Settings › Music › Footer): play/pause and the track's title in
// Deck's footer, and the player itself as the readout's menu, the way the memory readout opens its
// breakdown. Nothing over the page, nothing along the bottom: the footer is all it takes.
import { useRef, useState } from "react";
import { Music2, Pause, Play, X } from "lucide-react";
import { PanelHead, StatusItem, StatusPopover } from "../shim/ui.js";
import { usePlayer } from "./player";
import { Controls, Meta, SeekBar, nowPlaying, titleOf, volumeIcon } from "./PlayerBar";
import ListenButton from "./ListenButton";
import { usePlacement } from "./placement";

/** The footer has room for a short title, not a long one. */
const MAX = 28;
const cut = (s: string) => (s.length > MAX ? s.slice(0, MAX - 1).trimEnd() + "…" : s);

export default function FooterPlayer() {
  const p = usePlayer();
  const placement = usePlacement();
  const [open, setOpen] = useState(false);
  const prev = useRef(p.volume || 0.8);
  if (placement !== "footer" || (!p.current && !p.listening)) return null;
  const cur = nowPlaying(p), title = titleOf(cur);
  const Vol = volumeIcon(p.volume);
  const mute = () => { if (p.volume > 0) { prev.current = p.volume; p.setVolume(0); } else p.setVolume(prev.current || 0.8); };

  return (
    <StatusPopover open={open} onToggle={() => setOpen((v) => !v)} onClose={() => setOpen(false)} width="w-80"
      item={
        <div className={"flex items-center rounded-[4px]" + (open ? " bg-white/[0.08]" : "")}>
          {/* Play/pause straight from the footer, without opening the menu. */}
          <span onClick={(e) => { e.stopPropagation(); p.toggle(); }}>
            <StatusItem icon={p.playing ? <Pause /> : <Play />} color={p.playing ? "var(--accent)" : "var(--text-secondary)"} label=""
              title={p.playing ? "Pause" : "Play"} />
          </span>
          <StatusItem icon={<Music2 />} color="var(--text-secondary)" label={cut(title)}
            title={`${title}${cur.artist ? ` · ${cur.artist}` : ""}. Click for the player`} />
        </div>
      }>
      <PanelHead label={p.listening ? "Listening together" : "Now playing"} value={p.playing ? "Playing" : "Paused"} />
      <div className="flex flex-col gap-3 px-3.5 pb-3.5 pt-1.5">
        <Meta cur={cur} />
        <SeekBar duration={p.duration} onSeek={p.seek} />
        <div className="flex items-center justify-center gap-1"><Controls p={p} /></div>
        <div className="flex items-center gap-2 border-t border-subtle pt-2.5">
          <button onClick={mute} title={p.volume === 0 ? "Unmute" : "Mute"}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
            <Vol size={15} /></button>
          <input type="range" min={0} max={1} step={0.01} value={p.volume} aria-label="Volume"
            onChange={(e) => p.setVolume(Number(e.target.value))}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--accent)]" />
          <ListenButton />
          <button onClick={() => { setOpen(false); p.clear(); }} title={p.listening ? "Leave" : "Close player"}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
            <X size={15} /></button>
        </div>
      </div>
    </StatusPopover>
  );
}
