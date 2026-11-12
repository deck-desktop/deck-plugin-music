import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc, mediaSetNowPlaying, mediaSetPlayback, configRead, configWrite } from "../shim/bridge.js";
import { hostChanged, leave, listenView, setHostSource, stopHosting, subscribeListen } from "./listen";

// path = stable id/local file. streamUrl (optional) = a ready remote URL to play
// instead of the local file — used for Discover previews (a resolved YouTube stream).
export type Track = { path: string; title: string; artist?: string; artPath?: string; streamUrl?: string };

type PlayerState = {
  queue: Track[]; index: number; playing: boolean;
  duration: number; volume: number;
  shuffle: boolean; repeat: "off" | "all" | "one";
  current: Track | null;
  /** Listening with another Deck's host: only play/pause and the volume are this Deck's. */
  listening: boolean;
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
  // Listening with someone (listen.ts): their track plays in place of this Deck's queue, which is
  // left as it was (and so not saved again) and comes back on leaving.
  const lv = useSyncExternalStore(subscribeListen, listenView);
  const listening = lv.role === "listener";
  const sessionTrack = lv.role === "listener" ? lv.track : null;
  const sessionUrl = lv.role === "listener" ? lv.url : null;
  const current = useMemo<Track | null>(() => listening
    ? sessionTrack && { path: `listen:${sessionTrack.id}`, title: sessionTrack.title, artist: sessionTrack.artist, streamUrl: sessionUrl ?? undefined }
    : queue[index] ?? null,
  [listening, sessionTrack, sessionUrl, queue, index]);
  /** Paused here while listening: the host's play state is not followed until played again. */
  const held = useRef(false);

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
  const wasListening = useRef(false);
  useEffect(() => {
    const a = audio.current!;
    // Back from listening: this Deck's own track is loaded, not started.
    const quiet = wasListening.current && !listening;
    wasListening.current = listening;
    // A listener's track with nothing received yet is silent until it arrives.
    if (!current || (listening && !current.streamUrl)) { a.pause(); a.removeAttribute("src"); setPlaying(false); }
    else {
      a.src = current.streamUrl || convertFileSrc(current.path);
      a.load();
      if (!listening && !quiet) a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
      else setPlaying(false);
    }
    // A peer's track never names a picture on this Deck.
    if (current) mediaSetNowPlaying(current.title || nameFromPath(current.path), current.artist ?? "", listening ? "" : current.artPath ?? "").catch(() => {});
    /* eslint-disable-next-line */
  }, [current?.path, current?.streamUrl]);

  // A listener follows the host: where it is (counted on from when its state came) and whether it plays.
  useEffect(() => {
    if (lv.role !== "listener" || !lv.url) return;
    const a = audio.current!;
    const at = () => lv.pos + (lv.playing ? (Date.now() - lv.at) / 1000 : 0);
    const apply = () => {
      if (Math.abs(a.currentTime - at()) > 0.5) a.currentTime = at();
      if (lv.playing && !held.current) a.play().catch(() => {}); else if (!lv.playing) a.pause();
    };
    if (a.readyState >= 1) apply();
    else { a.addEventListener("loadedmetadata", apply, { once: true }); return () => a.removeEventListener("loadedmetadata", apply); }
  }, [lv]);
  useEffect(() => { if (!listening) held.current = false; }, [listening]);

  // Hosting: the listeners hear each track change, play and pause at once (seeks: the element's event).
  useEffect(() => { hostChanged(); }, [current?.path, playing]);

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
    a.addEventListener("seeked", hostChanged);
    return () => {
      a.removeEventListener("seeked", hostChanged);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("durationchange", onDur);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, []);

  // Playing something of this Deck's own ends listening with someone else.
  const play = (tracks: Track[], startAt = 0) => {
    if (!tracks.length) return;
    leave();
    // Playing from a session: start this track rather than load it quietly.
    wasListening.current = false;
    const i = Math.max(0, Math.min(startAt, tracks.length - 1));
    // The track already loaded: its path is the same, so the load below does not run again.
    if (!listening && tracks[i].path === current?.path) { const el = audio.current!; el.currentTime = 0; el.play().catch(() => {}); }
    setQueue(tracks); setIndex(i);
  };
  const toggle = () => {
    const a = audio.current!;
    if (listening) held.current = !a.paused;
    if (a.paused) {
      // The host is paused: nothing to catch up with.
      if (lv.role === "listener" && !lv.playing) return;
      // Played again while listening: back to where the host is now.
      if (lv.role === "listener") a.currentTime = lv.pos + (lv.playing ? (Date.now() - lv.at) / 1000 : 0);
      a.play().catch(() => {});
    } else a.pause();
  };
  // manual = user pressed Next (always wraps last→first); auto = track ended (respects repeat:
  // "one" replays, "all"/manual wrap, "off" stops at the end).
  const next = (manual = true) => {
    if (!queue.length || listening) return;
    if (!manual && repeat === "one") { const a = audio.current!; a.currentTime = 0; a.play().catch(() => {}); return; }
    let i = shuffle ? Math.floor(Math.random() * queue.length) : index + 1;
    if (i >= queue.length) {
      if (manual || repeat === "all") i = 0; else { setPlaying(false); return; }
    }
    setIndex(i);
  };
  const prev = () => {
    if (!queue.length || listening) return;
    const a = audio.current!;
    if (a.currentTime > 3) { a.currentTime = 0; return; } // restart current if >3s in
    setIndex((i) => (i - 1 + queue.length) % queue.length);
  };
  const seek = (t: number) => { if (listening) return; audio.current!.currentTime = t; setPosition(t); };
  const setVolume = (v: number) => { audio.current!.volume = v; setVol(v); };
  const cycleRepeat = () => setRepeat((r) => r === "off" ? "all" : r === "all" ? "one" : "off");
  // Listening, closing leaves and keeps this Deck's own queue; hosting, it ends the session.
  const clear = () => { if (listening) return leave(); stopHosting(); setQueue([]); setIndex(0); };

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

  // What the listeners are told, read when it goes out. The next track is the one after this in the
  // queue: none while shuffling, which picks at random.
  const hostNow = useRef({ queue, index, shuffle, repeat, current });
  hostNow.current = { queue, index, shuffle, repeat, current };
  useEffect(() => {
    setHostSource(() => {
      const { queue: q, index: i, shuffle: sh, repeat: r, current: c } = hostNow.current;
      const a = audio.current!;
      const n = sh ? null : q[i + 1] ?? (r === "all" ? q[0] : null) ?? null;
      return { track: c, next: n === c ? null : n, pos: a.currentTime, playing: !a.paused };
    });
    return () => setHostSource(null);
  }, []);

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
    () => ({ queue, index, playing, duration, volume, shuffle, repeat, current, listening, setShuffle, ...actions }),
    [queue, index, playing, duration, volume, shuffle, repeat, current, listening, actions],
  );

  return (
    <Ctx.Provider value={value}>
      {/* Inside, so a position tick re-renders only what reads the position — not this provider's
          own value, and not the app tree hanging off it. */}
      <PosCtx.Provider value={position}>{children}</PosCtx.Provider>
    </Ctx.Provider>
  );
}
