import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc, mediaSetNowPlaying, mediaSetPlayback, configRead, configWrite } from "../shim/bridge.js";

// path = stable id/local file. streamUrl (optional) = a ready remote URL to play
// instead of the local file — used for Discover previews (a resolved YouTube stream).
export type Track = { path: string; title: string; artist?: string; artPath?: string; streamUrl?: string };

type PlayerState = {
  queue: Track[]; index: number; playing: boolean;
  duration: number; volume: number;
  shuffle: boolean; repeat: "off" | "all" | "one";
  current: Track | null;
  play: (tracks: Track[], startAt?: number) => void;
  toggle: () => void; next: () => void; prev: () => void;
  seek: (t: number) => void; setVolume: (v: number) => void;
  setShuffle: (b: boolean) => void; cycleRepeat: () => void;
  clear: () => void;
};

const Ctx = createContext<PlayerState | null>(null);
export const usePlayer = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlayer must be used within PlayerProvider");
  return c;
};

// Playback position lives in its OWN context, because it is the one value here that changes
// several times a second. PlayerProvider wraps the whole app, so with position in the main
// context every timeupdate re-rendered the entire tree — the title bar, the wallpaper, whichever
// module was open — to move a seek bar. Only the seek bar reads this.
const PosCtx = createContext(0);
export const usePlayerPosition = () => useContext(PosCtx);

// Title from a file path if we don't have a nicer one.
const nameFromPath = (p: string) => p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? p;

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  if (!audio.current) audio.current = new Audio();
  // An Audio element is not in the DOM, so unmounting does not stop it. A plugin reload mounts a
  // fresh provider with its own element, which restores the queue and plays, while the old one
  // would play on with nothing left to pause it. Stopping it also releases the stream.
  useEffect(() => () => {
    const a = audio.current;
    if (a) { a.pause(); a.removeAttribute("src"); a.load(); }
  }, []);

  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVol] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const current = queue[index] ?? null;

  // Restore persisted queue/volume once.
  useEffect(() => {
    configRead("player").then((t) => {
      if (!t.trim()) return;
      try {
        const d = JSON.parse(t);
        if (Array.isArray(d.queue)) setQueue(d.queue);
        if (typeof d.index === "number") setIndex(d.index);
        if (typeof d.volume === "number") { setVol(d.volume); if (audio.current) audio.current.volume = d.volume; }
        if (d.shuffle) setShuffle(true);
        if (d.repeat) setRepeat(d.repeat);
      } catch { /* */ }
    }).catch((e) => console.warn("[music] player state load failed", e));
  }, []);
  // Persist queue/index/volume/modes (not position — cheap + avoids churn).
  useEffect(() => {
    configWrite("player", JSON.stringify({ queue, index, volume, shuffle, repeat })).catch((e) => console.warn("[music] player state save failed", e));
  }, [queue, index, volume, shuffle, repeat]);


  // Load the current track into the audio element + tell the OS overlay.
  useEffect(() => {
    const a = audio.current!;
    if (!current) { a.pause(); a.removeAttribute("src"); setPlaying(false); return; }
    a.src = current.streamUrl || convertFileSrc(current.path);
    a.load();
    a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    mediaSetNowPlaying(current.title || nameFromPath(current.path), current.artist ?? "", current.artPath ?? "").catch(() => {});
    /* eslint-disable-next-line */
  }, [current?.path]);

  // Keep the audio element's volume in sync — loading a new src resets an
  // HTMLAudioElement's .volume to 1, so re-apply on both volume + track change.
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume, current?.path]);

  // Mirror play state to OS.
  useEffect(() => { mediaSetPlayback(playing).catch(() => {}); }, [playing]);

  // Audio element events.
  useEffect(() => {
    const a = audio.current!;
    const onTime = () => setPosition(a.currentTime);
    const onDur = () => setDuration(a.duration || 0);
    const onEnd = () => latest.current.next(false); // auto-advance respects repeat mode
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("durationchange", onDur);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("durationchange", onDur);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, []);

  const play = (tracks: Track[], startAt = 0) => {
    if (!tracks.length) return;
    setQueue(tracks); setIndex(Math.max(0, Math.min(startAt, tracks.length - 1)));
  };
  const toggle = () => {
    const a = audio.current!;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  };
  // manual = user pressed Next (always wraps last→first); auto = track ended (respects repeat:
  // "one" replays, "all"/manual wrap, "off" stops at the end).
  const next = (manual = true) => {
    if (!queue.length) return;
    if (!manual && repeat === "one") { const a = audio.current!; a.currentTime = 0; a.play().catch(() => {}); return; }
    let i = shuffle ? Math.floor(Math.random() * queue.length) : index + 1;
    if (i >= queue.length) {
      if (manual || repeat === "all") i = 0; else { setPlaying(false); return; }
    }
    setIndex(i);
  };
  const prev = () => {
    if (!queue.length) return;
    const a = audio.current!;
    if (a.currentTime > 3) { a.currentTime = 0; return; } // restart current if >3s in
    setIndex((i) => (i - 1 + queue.length) % queue.length);
  };
  const seek = (t: number) => { audio.current!.currentTime = t; setPosition(t); };
  const setVolume = (v: number) => { audio.current!.volume = v; setVol(v); };
  const cycleRepeat = () => setRepeat((r) => r === "off" ? "all" : r === "all" ? "one" : "off");
  const clear = () => { setQueue([]); setIndex(0); };

  // The handlers above close over this render's queue/index/repeat, so they are new functions
  // every render — and a position tick (timeupdate, ~4/s) is a render. Consumers and listeners get
  // these wrappers instead: created once, always calling the latest closure through the ref.
  const latest = useRef({ play, toggle, next, prev, seek, setVolume, cycleRepeat, clear });
  latest.current = { play, toggle, next, prev, seek, setVolume, cycleRepeat, clear };
  const actions = useMemo(() => ({
    play: (tracks: Track[], startAt?: number) => latest.current.play(tracks, startAt),
    toggle: () => latest.current.toggle(),
    next: () => latest.current.next(),
    prev: () => latest.current.prev(),
    seek: (t: number) => latest.current.seek(t),
    setVolume: (v: number) => latest.current.setVolume(v),
    cycleRepeat: () => latest.current.cycleRepeat(),
    clear: () => latest.current.clear(),
  }), []);

  // OS media-key / overlay / tray → act on playback.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<string>("media-control", (e) => {
      switch (e.payload) {
        case "play": audio.current!.play().catch(() => {}); break;
        case "pause": audio.current!.pause(); break;
        case "toggle": actions.toggle(); break;
        case "next": actions.next(); break;
        case "previous": actions.prev(); break;
        case "stop": audio.current!.pause(); actions.clear(); break;
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, [actions]);

  // Memoised on state and the stable actions only, so a position tick (which re-renders this
  // provider) leaves the value — and so every usePlayer consumer — alone. setShuffle is a state
  // setter, stable already.
  const value = useMemo(
    () => ({ queue, index, playing, duration, volume, shuffle, repeat, current, setShuffle, ...actions }),
    [queue, index, playing, duration, volume, shuffle, repeat, current, actions],
  );

  return (
    <Ctx.Provider value={value}>
      {/* Inside, so a position tick re-renders only what reads the position — not this provider's
          own value, and not the app tree hanging off it. */}
      <PosCtx.Provider value={position}>{children}</PosCtx.Provider>
    </Ctx.Provider>
  );
}
