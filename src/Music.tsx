import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, type ConfirmState } from "./components/ConfirmDialog";
import { NamePrompt, type NamePromptState } from "./components/NamePrompt";
import {
  Music, Heart, ListMusic, FolderInput, Plus, Play, Pause, Search, MoreHorizontal,
  Download, X, Loader2, Check, AlertTriangle, FolderOpen, Shuffle, Clock, Disc3,
  Sparkles, RotateCw, PanelLeft,
} from "lucide-react";
import {readLibrary, writeLibrary, readTrackMeta, pickFolder, readDownloads, revealInFolder, convertFileSrc, defaultDownloadDir, configRead, configWrite, readMusicSuggestions, readMusicTaste, writeMusicTaste, type MusicLibrary, type MusicFolder, type MusicPlaylist, type TrackMeta, type DownloadItem, type SongSuggestion, type MusicSuggestions} from "../shim/bridge.js";
import { listAudioFiles, musicDiscover, resolveStreamUrl, musicThumbs } from "./music-rust";
import { useDownloads, enqueue, cancelOne, cancelEverything, retryOne, retryFailed, onDownloadDone } from "./downloads";
import { usePlayer, type Track } from "./player";

const newId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
const fmtDur = (s: number) => s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "–:––";
const art = (p?: string) => p ? convertFileSrc(p) : "";

// A selected view in the left nav.
type View =
  | { kind: "favorites" }
  | { kind: "downloads" }
  | { kind: "discover" }
  | { kind: "folder"; id: string }
  | { kind: "playlist"; id: string };

export default function MusicModule() {
  const player = usePlayer();
  const [naming, setNaming] = useState<NamePromptState | null>(null);
  const [lib, setLib] = useState<MusicLibrary>({ folders: [], favorites: [], playlists: [] });
  const [view, setView] = useState<View>({ kind: "downloads" });
  // In a narrow pane the library list is a drawer over the tracks rather than a column that would
  // squeeze them. Measured here rather than with a Deck hook so the plugin keeps working on a Deck
  // that has none.
  // A ref callback, so measuring starts whenever the element appears.
  const [rootEl, rootRef] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!rootEl) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 620));
    ro.observe(rootEl);
    return () => ro.disconnect();
  }, [rootEl]);
  const [libOpen, setLibOpen] = useState(false);
  const drawer = narrow && libOpen;
  // Picking a view closes the drawer: it has done its job.
  useEffect(() => { setLibOpen(false); }, [view]);
  const [metaCache, setMetaCache] = useState<Record<string, TrackMeta>>({});
  const [rows, setRows] = useState<TrackMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  // Songs handed off from Discover to the Downloads queue (nonce forces re-consume).
  const [handoff, setHandoff] = useState<{ items: { url: string; title: string }[]; target: string; nonce: number }>({ items: [], target: "", nonce: 0 });
  const sendToDownloads = (items: { url: string; title: string }[], target: string) => {
    setHandoff({ items, target, nonce: Date.now() });
    setView({ kind: "downloads" });
  };

  // Load library once. Folders are whatever the user added; there is no built-in one.
  useEffect(() => { readLibrary().then(setLib); }, []);
  const saveLib = (next: MusicLibrary) => { setLib(next); writeLibrary(next).catch(() => {}); };

  // Read metadata for a set of paths, using/filling the cache.
  const loadMeta = async (paths: string[]) => {
    setLoading(true);
    const missing = paths.filter((p) => !metaCache[p]);
    let cache = metaCache;
    if (missing.length) {
      const metas = await readTrackMeta(missing).catch(() => [] as TrackMeta[]);
      cache = { ...metaCache };
      metas.forEach((m) => (cache[m.path] = m));
      setMetaCache(cache);
    }
    setRows(paths.map((p) => cache[p]).filter(Boolean));
    setLoading(false);
  };

  // Resolve the current view → its track paths, then load meta.
  useEffect(() => {
    (async () => {
      if (view.kind === "favorites") { await loadMeta(lib.favorites); return; }
      if (view.kind === "folder") {
        const f = lib.folders.find((x) => x.id === view.id);
        if (!f) { setRows([]); return; }
        const files = await listAudioFiles(f.path).catch(() => [] as string[]);
        await loadMeta(files);
        return;
      }
      if (view.kind === "playlist") {
        const pl = lib.playlists.find((x) => x.id === view.id);
        await loadMeta(pl?.tracks ?? []);
        return;
      }
      // downloads view handles its own list
      setRows([]);
    })();
    /* eslint-disable-next-line */
  }, [view, lib.folders, lib.favorites, lib.playlists]);

  // ---- collection actions ----
  const addFolder = async () => {
    const picked = await pickFolder().catch(() => "");
    if (!picked) return;
    const path = picked; // absolute, wherever the user keeps their music
    if (lib.folders.some((f) => f.path === path)) return;
    const name = path.split(/[\\/]/).pop() || "Folder";
    saveLib({ ...lib, folders: [...lib.folders, { id: newId("f"), name, path }] });
  };
  const removeFolder = (id: string) =>
    saveLib({ ...lib, folders: lib.folders.filter((f) => f.id !== id) });
  const newPlaylist = () => setNaming({
    title: "New playlist", placeholder: "Late night", confirmLabel: "Create",
    onSave: (name) => saveLib({ ...lib, playlists: [...lib.playlists, { id: newId("p"), name, tracks: [] }] }),
  });
  const removePlaylist = (id: string) =>
    saveLib({ ...lib, playlists: lib.playlists.filter((p) => p.id !== id) });

  const isFav = (p: string) => lib.favorites.includes(p);
  const toggleFav = (p: string) =>
    saveLib({ ...lib, favorites: isFav(p) ? lib.favorites.filter((x) => x !== p) : [...lib.favorites, p] });
  const addToPlaylist = (playlistId: string, path: string) => {
    saveLib({ ...lib, playlists: lib.playlists.map((pl) =>
      pl.id === playlistId && !pl.tracks.includes(path) ? { ...pl, tracks: [...pl.tracks, path] } : pl) });
  };
  const removeFromPlaylist = (playlistId: string, path: string) =>
    saveLib({ ...lib, playlists: lib.playlists.map((pl) =>
      pl.id === playlistId ? { ...pl, tracks: pl.tracks.filter((t) => t !== path) } : pl) });

  // ---- playback ----
  const toTrack = (m: TrackMeta): Track => ({ path: m.path, title: m.title, artist: m.artist, artPath: m.art_path || undefined });
  const playRows = (startAt = 0, list = rows) => { if (list.length) player.play(list.map(toTrack), startAt); };

  const filtered = q.trim()
    ? rows.filter((r) => (r.title + r.artist + r.album).toLowerCase().includes(q.toLowerCase()))
    : rows;

  const viewTitle =
    view.kind === "favorites" ? "Favorites"
    : view.kind === "downloads" ? "Downloads"
    : view.kind === "discover" ? "Discover"
    : view.kind === "folder" ? (lib.folders.find((f) => f.id === view.id)?.name ?? "Folder")
    : view.kind === "playlist" ? (lib.playlists.find((p) => p.id === view.id)?.name ?? "Playlist")
    : "";

  return (
    <div ref={rootRef} className="relative flex h-full w-full gap-3 overflow-hidden">
      {/* The drawer's backdrop: a click beside it closes it. */}
      {drawer && <div className="absolute inset-0 z-20 bg-black/40" onClick={() => setLibOpen(false)} />}
      {/* LEFT: collections */}
      <aside className={"flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-subtle bg-panel/80 pr-3 backdrop-blur-xl blur-surface scroll-thin "
          + (narrow ? (drawer ? "absolute inset-y-0 left-0 z-30 pl-2 pt-2 shadow-2xl" : "hidden") : "")}
        style={drawer ? { background: "var(--bg-panel)" } : undefined}>
        <div className="px-2.5 pb-2 pt-0.5 text-sm font-semibold tracking-tight text-text-primary">Library</div>
        <NavItem icon={Sparkles} label="Discover" active={view.kind === "discover"} onClick={() => setView({ kind: "discover" })} />
        <NavItem icon={Heart} label="Favorites" active={view.kind === "favorites"} onClick={() => setView({ kind: "favorites" })} count={lib.favorites.length} />
        <NavItem icon={Download} label="Downloads" active={view.kind === "downloads"} onClick={() => setView({ kind: "downloads" })} />

        <SectionLabel>Folders</SectionLabel>
        {lib.folders.map((f) => (
          <NavItem key={f.id} icon={FolderOpen} label={f.name} active={view.kind === "folder" && view.id === f.id}
            onClick={() => setView({ kind: "folder", id: f.id })}
            onRemove={() => removeFolder(f.id)}
            onReveal={() => revealInFolder(f.path)} />
        ))}

        <SectionLabel>Playlists</SectionLabel>
        {lib.playlists.map((p) => (
          <NavItem key={p.id} icon={ListMusic} label={p.name} active={view.kind === "playlist" && view.id === p.id}
            onClick={() => setView({ kind: "playlist", id: p.id })} count={p.tracks.length}
            onRemove={() => removePlaylist(p.id)} />
        ))}

        <div className="mt-2 space-y-1 border-t border-subtle pt-2">
          <AddBtn icon={FolderInput} label="Add folder" onClick={addFolder} />
          <AddBtn icon={Plus} label="New playlist" onClick={newPlaylist} />
        </div>
      </aside>

      {/* MAIN */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {narrow && (
          <button onClick={() => setLibOpen((o) => !o)} title="Library"
            className="mb-3 flex shrink-0 items-center gap-2 self-start rounded-md border border-subtle px-2.5 py-1.5 text-sm text-text-secondary transition hover:text-text-primary">
            <PanelLeft size={15} /> {viewTitle || "Library"}
          </button>
        )}
        {view.kind === "discover" ? (
          <DiscoverPanel folders={lib.folders} onSend={sendToDownloads} />
        ) : view.kind === "downloads" ? (
          <DownloadPanel folders={lib.folders} onDownloaded={() => { setMetaCache({}); }}
            handoff={handoff} onHandoffConsumed={() => setHandoff((h) => ({ ...h, items: [] }))} />
        ) : (
          <>
            {/* Collection header */}
            <div className="mb-4 flex shrink-0 items-end gap-4">
              <div className="grid h-28 w-28 shrink-0 place-items-center rounded-xl shadow-card" style={{ background: "linear-gradient(135deg, var(--accent-strong), var(--bg-elev))" }}>
                {view.kind === "favorites" ? <Heart size={40} className="text-white" /> : <Disc3 size={40} className="text-white/90" />}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {view.kind === "playlist" ? "Playlist" : view.kind === "favorites" ? "Collection" : "Folder"}
                </div>
                <h1 className="truncate text-3xl font-bold text-text-primary">{viewTitle}</h1>
                <div className="mt-1 text-sm text-text-muted">{filtered.length} track{filtered.length === 1 ? "" : "s"}</div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => playRows(0)} disabled={!rows.length}
                    className="flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold text-white shadow-glow disabled:opacity-50" style={{ background: "var(--accent-strong)" }}>
                    <Play size={16} /> Play
                  </button>
                  <button onClick={() => { player.setShuffle(true); playRows(Math.floor(Math.random() * Math.max(1, rows.length))); }} disabled={!rows.length}
                    className="flex items-center gap-2 rounded-full border border-subtle px-4 py-2 text-sm text-text-secondary transition hover:text-text-primary disabled:opacity-50">
                    <Shuffle size={15} /> Shuffle
                  </button>
                  <div className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1.5" style={{ background: "var(--bg-elev)" }}>
                    <Search size={13} className="text-text-muted" />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
                      className="w-32 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted" />
                  </div>
                </div>
              </div>
            </div>

            {/* Track table */}
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center gap-2 px-3 py-8 text-sm text-text-muted"><Loader2 size={15} className="animate-spin" /> Reading tags…</div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-text-muted">
                  {view.kind === "favorites" ? "No favorites yet — star tracks to add them."
                    : view.kind === "playlist" ? "Empty playlist — add tracks from a folder (⋯ → Add to playlist)."
                    : "No audio here. Add a folder with music, or download some."}
                </div>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-subtle text-left text-[11px] uppercase tracking-wide text-text-muted">
                      <th className="w-10 py-2 pl-3 font-medium">#</th>
                      <th className="py-2 font-medium">Title</th>
                      <th className="hidden py-2 font-medium md:table-cell">Album</th>
                      <th className="w-10 py-2 font-medium"></th>
                      <th className="w-16 py-2 pr-3 text-right font-medium"><Clock size={13} className="ml-auto" /></th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((m, i) => {
                      const playingThis = player.current?.path === m.path;
                      return (
                        <tr key={m.path} onDoubleClick={() => playRows(i)}
                          className="group cursor-default border-b border-subtle/40 transition-colors hover:bg-white/[0.03]">
                          <td className="py-2 pl-3">
                            <button onClick={() => playRows(i)} className="grid h-6 w-6 place-items-center text-text-muted">
                              <span className="group-hover:hidden" style={{ color: playingThis ? "var(--accent)" : undefined }}>{playingThis && player.playing ? <Disc3 size={13} className="animate-spin" /> : i + 1}</span>
                              <Play size={13} className="hidden group-hover:block" />
                            </button>
                          </td>
                          {/* Single-click the title area to play. */}
                          <td className="py-2">
                            <div onClick={() => playRows(i)} className="flex cursor-pointer items-center gap-3">
                              <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded" style={{ background: "var(--bg-elev)" }}>
                                {m.art_path ? <img src={art(m.art_path)} className="h-full w-full object-cover" alt="" /> : <Music size={14} className="text-text-muted" />}
                              </div>
                              <div className="min-w-0">
                                <div className="truncate font-medium" style={{ color: playingThis ? "var(--accent)" : "var(--text-primary)" }}>{m.title}</div>
                                <div className="truncate text-xs text-text-muted">{m.artist || "Unknown artist"}</div>
                              </div>
                            </div>
                          </td>
                          <td className="hidden truncate py-2 text-text-muted md:table-cell">{m.album}</td>
                          <td className="py-2">
                            <button onClick={() => toggleFav(m.path)} title="Favorite"
                              className="opacity-0 transition group-hover:opacity-100" style={{ opacity: isFav(m.path) ? 1 : undefined }}>
                              <Heart size={15} fill={isFav(m.path) ? "var(--accent)" : "none"} style={{ color: isFav(m.path) ? "var(--accent)" : "var(--text-muted)" }} />
                            </button>
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-text-muted">{fmtDur(m.duration)}</td>
                          <td className="py-2 pr-2">
                            <RowMenu playlists={lib.playlists}
                              onAddToPlaylist={(pid) => addToPlaylist(pid, m.path)}
                              onRemoveFromPlaylist={view.kind === "playlist" ? () => removeFromPlaylist(view.id, m.path) : undefined}
                              onReveal={() => revealInFolder(m.path)} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </main>
      <NamePrompt state={naming} onClose={() => setNaming(null)} />
    </div>
  );
}

// ---- left nav pieces ----
const SectionLabel = ({ children }: { children: React.ReactNode }) =>
  <div className="mt-3 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{children}</div>;

function NavItem({ icon: Icon, label, active, onClick, count, onRemove, onReveal }: {
  icon: any; label: string; active: boolean; onClick: () => void;
  count?: number; onRemove?: () => void; onReveal?: () => void;
}) {
  return (
    <div className={"group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors " +
      (active ? "text-text-primary" : "text-text-secondary hover:bg-elev hover:text-text-primary")}
      style={active ? { background: "var(--accent-soft)", boxShadow: "inset 0 0 0 1px var(--accent-soft)" } : undefined}>
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2.5">
        <Icon size={16} className="shrink-0" style={{ color: active ? "var(--accent)" : "var(--text-muted)" }} />
        <span className="truncate">{label}</span>
      </button>
      {count != null && count > 0 && (
        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
          style={{ background: "var(--bg-elev)", color: "var(--text-muted)" }}>{count}</span>
      )}
      {(onRemove || onReveal) && (
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {onReveal && <button onClick={onReveal} title="Reveal" className="text-text-muted hover:text-text-primary"><FolderOpen size={13} /></button>}
          {onRemove && <button onClick={onRemove} title="Remove from library" className="text-text-muted hover:text-danger"><X size={13} /></button>}
        </div>
      )}
    </div>
  );
}

const AddBtn = ({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) => (
  <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-text-muted transition hover:bg-elev hover:text-text-primary">
    <Icon size={16} /> {label}
  </button>
);

function RowMenu({ playlists, onAddToPlaylist, onRemoveFromPlaylist, onReveal }: {
  playlists: MusicPlaylist[];
  onAddToPlaylist: (pid: string) => void; onRemoveFromPlaylist?: () => void; onReveal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  // Open upward when the row is near the viewport bottom, so the menu isn't clipped
  // by the list's overflow container (menu is ~220px tall for a few playlists).
  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!open) { const r = e.currentTarget.getBoundingClientRect(); setDropUp(window.innerHeight - r.bottom < 240); }
    setOpen((v) => !v);
  };
  return (
    <div className="relative">
      <button onClick={toggle} className="opacity-0 transition group-hover:opacity-100 text-text-muted hover:text-text-primary"><MoreHorizontal size={16} /></button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={"absolute right-0 z-50 w-44 rounded-lg border border-subtle p-1 shadow-card " + (dropUp ? "bottom-full mb-1" : "mt-1")} style={{ background: "var(--bg-card)" }}>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted">Add to playlist</div>
            {playlists.length === 0 && <div className="px-2 py-1 text-xs text-text-muted">No playlists</div>}
            {playlists.map((pl) => (
              <button key={pl.id} onClick={() => { onAddToPlaylist(pl.id); setOpen(false); }}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-text-secondary hover:bg-elev hover:text-text-primary">{pl.name}</button>
            ))}
            <div className="my-1 border-t border-subtle" />
            {onRemoveFromPlaylist && <button onClick={() => { onRemoveFromPlaylist(); setOpen(false); }} className="block w-full rounded px-2 py-1.5 text-left text-sm text-danger hover:bg-elev">Remove from playlist</button>}
            <button onClick={() => { onReveal(); setOpen(false); }} className="block w-full rounded px-2 py-1.5 text-left text-sm text-text-secondary hover:bg-elev hover:text-text-primary">Reveal in folder</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Download sub-view (composer + queue + history), targets a library folder ----
function DownloadPanel({ folders, onDownloaded, handoff, onHandoffConsumed }: {
  folders: MusicFolder[]; onDownloaded: () => void;
  handoff?: { items: { url: string; title: string }[]; target: string; nonce: number };
  onHandoffConsumed?: () => void;
}) {
  const [urls, setUrls] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [quality, setQuality] = useState("0");
  const [target, setTarget] = useState<string>(folders[0]?.path ?? "");
  const [history, setHistory] = useState<DownloadItem[]>([]);
  const player = usePlayer();
  // Queue lives in the persistent store so it survives tab switches (component unmount).
  const { queue, running } = useDownloads();

  const loadHistory = () => readDownloads().then((t) => { try { setHistory(t.trim() ? JSON.parse(t) : []); } catch { setHistory([]); } }).catch(() => {});
  useEffect(() => {
    // Target priority: saved setting → first library folder → Windows Downloads folder.
    configRead("dl-settings").then((t) => {
      try { const d = JSON.parse(t); if (d.target) setTarget(d.target); if (d.quality) setQuality(d.quality); } catch { /* */ }
    }).catch(() => {}).finally(() => {
      setTarget((cur) => cur || folders[0]?.path || "");
      if (!folders.length) defaultDownloadDir().then((d) => setTarget((cur) => cur || d)).catch(() => {});
    });
    loadHistory();
    // Refresh history + let the collection re-scan whenever a download completes.
    const un = onDownloadDone(() => { loadHistory(); onDownloaded(); });
    return () => { un(); };
  }, []);
  useEffect(() => { configWrite("dl-settings", JSON.stringify({ target, quality })).catch(() => {}); }, [target, quality]);

  const start = () => {
    const list = urls.split("\n").map((u) => u.trim()).filter(Boolean);
    if (!list.length) return;
    const go = () => {
      setUrls("");
      enqueue(list.map((url) => ({ url, title: url })), target, quality);
    };
    // A Mix/Radio playlist expands to hundreds of tracks, which is rarely what was meant by
    // pasting one link.
    if (list.some((u) => /[?&]list=RD/.test(u))) {
      setConfirm({
        title: "Download the whole Mix?",
        body: "That link is a YouTube Mix or Radio playlist, which can be 800 tracks or more.",
        confirmLabel: "Download anyway",
        onConfirm: go,
      });
      return;
    }
    go();
  };

  // Discover hands off picked songs here — enqueue into the store, into the chosen folder.
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!handoff || handoff.nonce === lastNonce.current || !handoff.items.length) return;
    lastNonce.current = handoff.nonce;
    if (handoff.target) setTarget(handoff.target);
    enqueue(handoff.items, handoff.target || target, "0");
    onHandoffConsumed?.();
    /* eslint-disable-next-line */
  }, [handoff?.nonce]);

  return (
    <>
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <h1 className="text-2xl font-bold text-text-primary">Add music</h1>
      <div className="rounded-xl border border-subtle p-4" style={{ background: "var(--bg-card-glass)" }}>
        <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={3}
          placeholder="Paste one or more URLs, one per line…"
          className="scroll-thin w-full resize-none rounded-lg px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted" style={{ background: "var(--bg-elev)" }} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Audio only. This is a music library — a downloaded video is not something anything
              else here can play, sort or tag, and the format toggle only ever offered a way to
              fill the library with files it does not understand. */}
          <select value={quality} onChange={(e) => setQuality(e.target.value)} className="rounded-lg px-3 py-2 text-sm text-text-secondary outline-none" style={{ background: "var(--bg-elev)" }}>
            {[["0", "Best"], ["192K", "192k"], ["128K", "128k"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {/* Target folder = a library folder */}
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="max-w-[200px] rounded-lg px-3 py-2 text-sm text-text-secondary outline-none" style={{ background: "var(--bg-elev)" }} title="Download into folder">
            {folders.length === 0 && <option value={target}>{target.split(/[\\/]/).pop() || "Downloads"}</option>}
            {folders.map((f) => <option key={f.id} value={f.path}>{f.name}</option>)}
          </select>
          {running
            ? <button onClick={cancelEverything} className="ml-auto flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white" style={{ background: "var(--danger)" }}><X size={15} /> Cancel</button>
            : <button onClick={start} disabled={!urls.trim()} className="ml-auto flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-glow disabled:opacity-50" style={{ background: "var(--accent-strong)" }}><Download size={15} /> Download</button>}
          {running && <button onClick={start} disabled={!urls.trim()} title="Add to queue" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: "var(--accent-strong)" }}><Plus size={15} /></button>}
        </div>
        {folders.length === 0 && <p className="mt-2 text-xs text-text-muted">Tip: add a folder in the sidebar to download into a collection.</p>}
      </div>

      {queue.length > 0 && (
        <div className="rounded-xl border border-subtle p-2" style={{ background: "var(--bg-card-glass)" }}>
          {queue.some((r) => r.status === "failed") && (
            <button onClick={retryFailed} className="mb-1 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold text-accent hover:bg-[var(--bg-elev)]">
              <RotateCw size={13} /> Retry all failed
            </button>
          )}
          {queue.map((r) => {
            const isPl = !!r.plCount && r.plCount !== "1"; const idx = parseInt(r.plIndex || "0") || 0; const cnt = parseInt(r.plCount || "0") || 0;
            const trackPct = parseInt(r.pct) || 0; const pct = isPl && cnt ? Math.round(((idx - 1 + trackPct / 100) / cnt) * 100) : trackPct;
            return (
              <div key={r.id} className="rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-3">
                  {r.status === "downloading" ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" /> : r.status === "done" ? <Check size={14} className="shrink-0 text-ok" /> : r.status === "failed" ? <X size={14} className="shrink-0 text-danger" /> : <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-subtle" />}
                  <span className="flex-1 truncate text-sm text-text-primary">{isPl ? `${r.plTitle || "Playlist"} — ${idx}/${cnt}` : r.title}</span>
                  {r.status === "downloading" && <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{r.speed} · {r.eta}</span>}
                  {r.status === "downloading" && <button onClick={() => cancelOne(r.id)} className="text-text-muted hover:text-danger"><X size={13} /></button>}
                  {r.status === "failed" && <button onClick={() => retryOne(r.id)} title="Retry" className="text-text-muted hover:text-accent"><RotateCw size={13} /></button>}
                </div>
                {(r.status === "downloading" || r.status === "queued") && <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--bg-elev)" }}><div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--accent)" }} /></div>}
                {r.status === "failed" && <p className="mt-1 truncate text-[11px] text-danger">{r.error}</p>}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-subtle p-2" style={{ background: "var(--bg-card-glass)" }}>
        <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Recent downloads</div>
        {history.length === 0 ? <p className="px-3 py-4 text-sm text-text-muted">Nothing yet.</p> : (
          <div className="space-y-0.5">
            {history.slice(0, 30).map((h) => (
              <div key={h.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/[0.02]">
                {h.status === "done" ? <Check size={13} className="shrink-0 text-ok" /> : <AlertTriangle size={13} className="shrink-0 text-danger" />}
                <span className="flex-1 truncate text-sm text-text-secondary">{h.title}</span>
                {h.status === "failed" && h.url && <button onClick={() => enqueue([{ url: h.url, title: h.title }], target, h.quality || "0")} title="Retry" className="text-text-muted hover:text-accent"><RotateCw size={13} /></button>}
                {h.filePath && h.status === "done" && <button onClick={() => player.play([{ path: h.filePath!, title: h.title }], 0)} title="Play" className="text-text-muted hover:text-text-primary"><Play size={13} /></button>}
                {h.filePath && <button onClick={() => revealInFolder(h.filePath!)} title="Reveal" className="text-text-muted hover:text-text-primary"><FolderOpen size={13} /></button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </>
  );
}

// ---- Discover sub-view: AI (VPS) suggests new songs; pick + download to a folder ----
const AUTO_END = "<!-- /AUTO -->";
// Split taste.md into the AUTO block (read-only, Claude-owned) and the MANUAL tail (editable).
// The MANUAL side strips the HTML comment marker so only the user's own words show/edit.
function splitTaste(md: string): { auto: string; manual: string } {
  const strip = (s: string) => s.replace(/<!--.*?-->/gs, "").trim();
  const i = md.indexOf(AUTO_END);
  if (i === -1) return { auto: "", manual: strip(md) };
  return { auto: md.slice(0, i + AUTO_END.length), manual: strip(md.slice(i + AUTO_END.length)) };
}

function DiscoverPanel({ folders, onSend }: {
  folders: MusicFolder[];
  onSend: (items: { url: string; title: string }[], target: string) => void;
}) {
  const [sugg, setSugg] = useState<MusicSuggestions | null>(null);
  const [taste, setTaste] = useState<string>("");      // full taste.md
  const [manual, setManual] = useState<string>("");    // editable MANUAL tail
  const [count, setCount] = useState(10);
  const [discovering, setDiscovering] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<string>(folders[0]?.path ?? "");
  const [sent, setSent] = useState(false); // brief "sent to Downloads" confirmation
  const [thumbs, setThumbs] = useState<Record<string, string>>({}); // song id → thumbnail URL
  const [gotTitles, setGotTitles] = useState<string[]>([]); // normalized titles already downloaded
  const lastGen = useRef<number>(0);
  const player = usePlayer();
  const [resolving, setResolving] = useState<string | null>(null);
  // A card is "playing" when the global player's current track is this suggestion.
  const isPlaying = (id: string) => player.current?.path === id && player.playing;

  // Preview through the SAME global player (bottom bar, media keys, SMTC). We resolve
  // the stream URL, then hand a Track (path = song id) to the player.
  const preview = async (s: SongSuggestion) => {
    if (player.current?.path === s.id) { player.toggle(); return; } // toggle current
    setResolving(s.id);
    try {
      const url = await resolveStreamUrl(`ytsearch1:${s.artist} ${s.title} audio`);
      player.play([{ path: s.id, title: s.title, artist: s.artist, artPath: thumbs[s.id] || undefined, streamUrl: url }]);
    } catch { /* resolve failed */ }
    finally { setResolving(null); }
  };

  const load = () => {
    readMusicSuggestions().then((s) => {
      if (s && s.generated_at !== lastGen.current) { lastGen.current = s.generated_at; setSugg(s); setDiscovering(false); }
    }).catch(() => {});
  };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const loadDownloaded = () =>
    readDownloads().then((t) => {
      try { const h: DownloadItem[] = t.trim() ? JSON.parse(t) : []; setGotTitles(h.filter((x) => x.status === "done").map((x) => norm(x.title))); }
      catch { /* */ }
    }).catch(() => {});
  // A suggestion is "already downloaded" if its artist+title words appear in a past download title.
  const isDownloaded = (s: SongSuggestion) => {
    const key = norm(`${s.artist} ${s.title}`).split(" ").filter((w) => w.length > 2);
    return key.length > 0 && gotTitles.some((t) => key.every((w) => t.includes(w)));
  };

  useEffect(() => {
    readMusicTaste().then((md) => { setTaste(md); setManual(splitTaste(md).manual.trim()); }).catch(() => {});
    configRead("dl-settings").then((t) => { try { const d = JSON.parse(t); if (d.target) setTarget(d.target); } catch { /* */ } }).catch(() => {});
    load(); loadDownloaded();
    // Suggestions + downloads arrive from other views and the MCP download tool — poll to stay fresh.
    const iv = setInterval(() => { load(); loadDownloaded(); }, 5000);
    return () => clearInterval(iv);
    /* eslint-disable-next-line */
  }, []);

  // Card thumbnails: cache by suggestion-set generated_at so we only run the (slow,
  // sequential yt-dlp) fetch once per new set — not on every mount/poll. Cache in
  // music-thumbs.json; reuse it while the suggestions are unchanged.
  useEffect(() => {
    const list = sugg?.songs ?? [];
    const gen = sugg?.generated_at;
    if (!list.length || !gen) return;
    let cancelled = false;
    configRead("music-thumbs").then((t) => {
      try { const c = JSON.parse(t); if (c.gen === gen && c.thumbs) { if (!cancelled) setThumbs(c.thumbs); return; } } catch { /* */ }
      musicThumbs(list.map((s) => `${s.artist} ${s.title} audio`)).then((urls) => {
        if (cancelled) return;
        const thumbs = Object.fromEntries(list.map((s, i) => [s.id, urls[i] || ""]));
        setThumbs(thumbs);
        configWrite("music-thumbs", JSON.stringify({ gen, thumbs })).catch(() => {});
      }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sugg?.generated_at]);

  const discover = async () => {
    setDiscovering(true); setChecked({});
    await musicDiscover(count).catch(() => setDiscovering(false));
    // result lands in music-suggestions.json after ~40s; the poll picks it up. Stop spinner after 3min max.
    setTimeout(() => setDiscovering(false), 180_000);
  };

  const saveManual = () => {
    const { auto } = splitTaste(taste);
    const head = auto || "# Music taste\n\n<!-- AUTO: Claude maintains this. -->\n(pending)\n<!-- /AUTO -->";
    const merged = `${head}\n\n<!-- MANUAL: write anything you like — artists, genres, moods. Claude never edits this. -->\n${manual.trim()}\n`;
    setTaste(merged); writeMusicTaste(merged).catch(() => {});
  };

  const songs = sugg?.songs ?? [];
  const anyChecked = songs.some((s) => checked[s.id]);
  // Select-all picks only the not-yet-downloaded ones.
  const toggleAll = () => {
    const pickable = songs.filter((s) => !isDownloaded(s));
    const all = pickable.length > 0 && pickable.every((s) => checked[s.id]);
    setChecked(all ? {} : Object.fromEntries(pickable.map((s) => [s.id, true])));
  };

  // Hand the picked songs to the Downloads queue (they download there, not inline).
  const downloadSelected = () => {
    const picks = songs.filter((s) => checked[s.id]);
    if (!picks.length || !target) return;
    onSend(picks.map((s) => ({ url: `ytsearch1:${s.artist} ${s.title} audio`, title: `${s.artist} — ${s.title}` })), target);
    setChecked({}); setSent(true); setTimeout(() => setSent(false), 1500);
  };

  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <div className="flex items-center gap-2">
        <Sparkles size={22} style={{ color: "var(--accent)" }} />
        <h1 className="text-2xl font-bold text-text-primary">Discover</h1>
        {sugg && <span className="text-xs text-text-muted">updated {relDays(sugg.generated_at)}</span>}
      </div>

      {/* Taste profile — MANUAL block editable, AUTO shown read-only */}
      <div className="rounded-xl border border-subtle p-4" style={{ background: "var(--bg-card-glass)" }}>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Your taste</div>
        {splitTaste(taste).auto && (
          <p className="mb-3 whitespace-pre-wrap rounded-lg p-3 text-xs leading-relaxed text-text-secondary" style={{ background: "var(--bg-elev)" }}>
            {splitTaste(taste).auto.replace(/<!--.*?-->/gs, "").replace(/^#.*$/gm, "").trim()}
          </p>
        )}
        <textarea value={manual} onChange={(e) => setManual(e.target.value)} onBlur={saveManual} rows={3}
          placeholder="Add your own notes — favourite artists, genres, moods you want more of…"
          className="scroll-thin w-full resize-none rounded-lg px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted" style={{ background: "var(--bg-elev)" }} />
      </div>

      {/* Discover controls */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="rounded-lg px-3 py-2 text-sm text-text-secondary outline-none" style={{ background: "var(--bg-elev)" }}>
          {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n} songs</option>)}
        </select>
        <select value={target} onChange={(e) => setTarget(e.target.value)} className="max-w-[200px] rounded-lg px-3 py-2 text-sm text-text-secondary outline-none" style={{ background: "var(--bg-elev)" }} title="Download into folder">
          {folders.length === 0 && <option value="">No folder — add one first</option>}
          {folders.map((f) => <option key={f.id} value={f.path}>{f.name}</option>)}
        </select>
        <button onClick={discover} disabled={discovering}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-glow disabled:opacity-60" style={{ background: "var(--accent-strong)" }}>
          {discovering ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
          {discovering ? "Finding songs…" : sugg ? "Refresh" : "Discover"}
        </button>
        {songs.length > 0 && (
          <>
            <button onClick={toggleAll} className="rounded-lg border border-subtle px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
              {songs.every((s) => checked[s.id]) ? "Clear" : "Select all"}
            </button>
            <button onClick={downloadSelected} disabled={!anyChecked || !target}
              className="ml-auto flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: "var(--accent-strong)" }}>
              {sent ? <Check size={15} /> : <Download size={15} />}
              {sent ? "Sent to Downloads" : "Download selected"}
            </button>
          </>
        )}
      </div>

      {discovering && songs.length === 0 && (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-text-muted"><Loader2 size={15} className="animate-spin" /> The AI is searching for new songs in your taste… (~40s)</div>
      )}
      {!discovering && songs.length === 0 && (
        <div className="px-1 py-8 text-sm text-text-muted">No suggestions yet. Set your taste above, then hit Discover.</div>
      )}

      {/* Suggestion cards */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {songs.map((s) => {
          const thumb = thumbs[s.id];
          const got = isDownloaded(s);
          return (
            <label key={s.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-subtle p-3 transition hover:border-strong"
              style={{ background: "var(--bg-card-glass)", opacity: got ? 0.55 : 1 }}>
              <input type="checkbox" checked={!!checked[s.id]} onChange={(e) => setChecked((c) => ({ ...c, [s.id]: e.target.checked }))}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]" />
              {/* Art tile = real YouTube thumbnail + preview play/pause overlay. */}
              <button type="button" onClick={(e) => { e.preventDefault(); preview(s); }} title="Preview"
                className="group/pv relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg" style={{ background: "linear-gradient(135deg, var(--accent-strong), var(--bg-elev))" }}>
                {thumb && <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" />}
                <div className="absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition group-hover/pv:opacity-100" style={{ opacity: isPlaying(s.id) || resolving === s.id ? 1 : undefined }}>
                  {resolving === s.id ? <Loader2 size={16} className="animate-spin text-white" />
                    : isPlaying(s.id) ? <Pause size={16} className="text-white" />
                    : <Play size={16} className="text-white" />}
                </div>
                {!thumb && resolving !== s.id && !isPlaying(s.id) && <Music size={16} className="text-white/80" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold" style={{ color: isPlaying(s.id) ? "var(--accent)" : "var(--text-primary)" }}>{s.title}</span>
                  {got && <span className="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ok" style={{ background: "var(--bg-elev)" }}><Check size={9} /> Got it</span>}
                </div>
                <div className="truncate text-xs text-text-muted">{s.artist}</div>
                <div className="mt-1 text-[11px] leading-snug text-text-secondary">{s.why}</div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

const relDays = (ms: number): string => {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 3_600_000) return "just now";
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
};
