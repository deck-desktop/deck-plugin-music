import { useEffect, useRef, useState } from "react";
import {
  ConfirmDialog, ContextMenu, NamePrompt,
  type ConfirmState, type MenuEntry, type NamePromptState,
} from "../shim/ui.js";
import {
  Music, Heart, ListMusic, FolderInput, Plus, Play, Pause, Search, MoreHorizontal,
  Download, X, Loader2, Check, AlertTriangle, FolderOpen, Shuffle, Clock, Disc3,
  Sparkles, RotateCw, PanelLeft,
} from "lucide-react";
import {readTrackMeta, pickFolder, revealInFolder, convertFileSrc, dirsDownload, configRead, configWrite, type TrackMeta} from "../shim/bridge.js";
import {readLibrary, writeLibrary, readDownloads, readMusicSuggestions, readMusicTaste, writeMusicTaste, type MusicLibrary, type MusicFolder, type MusicPlaylist, type DownloadItem, type SongSuggestion, type MusicSuggestions} from "./library";
import { listAudioFiles, musicDiscover, resolveStreamUrl, musicThumbs } from "./music-rust";
import { useDownloads, enqueue, cancelOne, cancelEverything, retryOne, retryFailed, onDownloadDone } from "./downloads";
import { usePlayer, type Track } from "./player";

const newId = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
const fmtDur = (s: number) => s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "–:––";
const art = (p?: string) => p ? convertFileSrc(p) : "";

// Deck's design guide (docs/design.md), as the classes this screen repeats.
/** An icon button inside a row: one step stronger on hover so it shows against the row's own. */
const iconBtn = "grid size-5 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-text-primary";
const dangerBtn = "grid size-5 shrink-0 place-items-center rounded text-text-muted transition-colors hover:bg-white/10 hover:text-red-400";
/** The one accent-filled action on a screen; give it `style={accentFill}`. */
const primaryBtn = "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium text-white transition hover:brightness-110 disabled:opacity-50 disabled:hover:brightness-100";
const accentFill = { background: "var(--accent)" };
const secondaryBtn = "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary disabled:opacity-50 disabled:hover:border-subtle";
/** A text box or dropdown on the elevated surface, lit in the accent while focused. Its text
 *  colour is the caller's: two colour classes on one element resolve by stylesheet order. */
const field = "rounded-lg border border-subtle bg-elev text-[12.5px] outline-none transition-colors placeholder:text-text-muted focus:border-[var(--accent)]";
const heading = "text-[12px] font-medium text-text-secondary";
/** A state in its colour: the text in it, the background the same at 14%. */
const chip = (color: string) => ({ color, background: `color-mix(in srgb, ${color} 14%, transparent)` });

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
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
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
  const saveLib = (next: MusicLibrary) => { setLib(next); writeLibrary(next).catch((e) => console.warn("[music] library save failed", e)); };

  // Read metadata for a set of paths, using/filling the cache.
  const loadMeta = async (paths: string[]) => {
    setLoading(true);
    const missing = paths.filter((p) => !metaCache[p]);
    let cache = metaCache;
    if (missing.length) {
      const metas = await readTrackMeta(missing).catch((e) => { console.warn("[music] track metadata read failed", e); return [] as TrackMeta[]; });
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
        const files = await listAudioFiles(f.path).catch((e) => { console.warn("[music] folder list failed", e); return [] as string[]; });
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
    const picked = await pickFolder().catch((e) => { console.warn("[music] folder picker failed", e); return ""; });
    if (!picked) return;
    const path = picked; // absolute, wherever the user keeps their music
    if (lib.folders.some((f) => f.path === path)) return;
    const name = path.split(/[\\/]/).pop() || "Folder";
    saveLib({ ...lib, folders: [...lib.folders, { id: newId("f"), name, path }] });
  };
  const removeFolder = (id: string) => setConfirm({
    title: `Remove ${lib.folders.find((f) => f.id === id)?.name ?? "this folder"} from the library?`,
    body: "Its songs leave the library. The files stay on disk.",
    confirmLabel: "Remove",
    onConfirm: () => saveLib({ ...lib, folders: lib.folders.filter((f) => f.id !== id) }),
  });
  const newPlaylist = () => setNaming({
    title: "New playlist", placeholder: "Late night", confirmLabel: "Create",
    onSave: (name) => saveLib({ ...lib, playlists: [...lib.playlists, { id: newId("p"), name, tracks: [] }] }),
  });
  const removePlaylist = (id: string) => setConfirm({
    title: `Delete the playlist ${lib.playlists.find((p) => p.id === id)?.name ?? ""}?`,
    body: "The playlist goes; its songs stay in the library and on disk.",
    confirmLabel: "Delete playlist",
    onConfirm: () => saveLib({ ...lib, playlists: lib.playlists.filter((p) => p.id !== id) }),
  });

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
      {/* As a drawer it floats over the tracks, so it takes the floating surface. */}
      <aside className={"flex w-56 shrink-0 flex-col gap-px overflow-y-auto border-r border-subtle bg-panel/80 pr-3 backdrop-blur-xl blur-surface scroll-thin "
          + (narrow ? (drawer ? "absolute inset-y-0 left-0 z-30 rounded-[10px] border border-subtle p-1.5 shadow-2xl" : "hidden") : "")}
        style={drawer ? { background: "var(--bg-card)" } : undefined}>
        <NavItem icon={Sparkles} label="Discover" active={view.kind === "discover"} onClick={() => setView({ kind: "discover" })} />
        <NavItem icon={Heart} label="Favorites" active={view.kind === "favorites"} onClick={() => setView({ kind: "favorites" })} count={lib.favorites.length} />
        <NavItem icon={Download} label="Downloads" active={view.kind === "downloads"} onClick={() => setView({ kind: "downloads" })} />

        {/* Each section's add button on its heading, and as the way in while the section is empty. */}
        <SectionLabel action={<button onClick={addFolder} title="Add folder" className={iconBtn}><FolderInput size={13} /></button>}>Folders</SectionLabel>
        {lib.folders.map((f) => (
          <NavItem key={f.id} icon={FolderOpen} label={f.name} active={view.kind === "folder" && view.id === f.id}
            onClick={() => setView({ kind: "folder", id: f.id })}
            onRemove={() => removeFolder(f.id)}
            onReveal={() => revealInFolder(f.path)} />
        ))}
        {!lib.folders.length && <AddBtn icon={FolderInput} label="Add folder" onClick={addFolder} />}

        <SectionLabel action={<button onClick={newPlaylist} title="New playlist" className={iconBtn}><Plus size={13} /></button>}>Playlists</SectionLabel>
        {lib.playlists.map((p) => (
          <NavItem key={p.id} icon={ListMusic} label={p.name} active={view.kind === "playlist" && view.id === p.id}
            onClick={() => setView({ kind: "playlist", id: p.id })} count={p.tracks.length}
            onRemove={() => removePlaylist(p.id)} />
        ))}
        {!lib.playlists.length && <AddBtn icon={Plus} label="New playlist" onClick={newPlaylist} />}
      </aside>

      {/* MAIN */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {narrow && (
          <button onClick={() => setLibOpen((o) => !o)} title="Library"
            className={secondaryBtn + " mb-3 self-start"}>
            <PanelLeft size={14} /> {viewTitle || "Library"}
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
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-text-muted">
                  {view.kind === "playlist" ? "Playlist" : view.kind === "favorites" ? "Collection" : "Folder"}
                </div>
                <h1 className="truncate text-3xl font-bold text-text-primary">{viewTitle}</h1>
                <div className="mt-1 text-[12.5px] text-text-muted">{filtered.length} track{filtered.length === 1 ? "" : "s"}</div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => playRows(0)} disabled={!rows.length} className={primaryBtn} style={accentFill}>
                    <Play size={14} /> Play
                  </button>
                  <button onClick={() => { player.setShuffle(true); playRows(Math.floor(Math.random() * Math.max(1, rows.length))); }} disabled={!rows.length}
                    className={secondaryBtn}>
                    <Shuffle size={14} /> Shuffle
                  </button>
                  <div className="ml-auto flex h-8 items-center gap-1.5 rounded-lg border border-subtle bg-elev pl-2.5 pr-2 transition-colors focus-within:border-[var(--accent)]">
                    <Search size={13} className="shrink-0 text-text-muted" />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
                      className="w-32 min-w-0 bg-transparent text-[12.5px] text-text-primary outline-none placeholder:text-text-muted" />
                  </div>
                </div>
              </div>
            </div>

            {/* Track table */}
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center gap-2 px-3 py-8 text-[12.5px] text-text-muted"><Loader2 size={14} className="animate-spin" /> Reading tags…</div>
              ) : filtered.length === 0 ? (
                q.trim() && rows.length ? (
                  <p className="px-3 py-6 text-[12.5px] text-text-muted">Nothing here matches “{q.trim()}”.</p>
                ) : (
                  <div className="mx-auto mt-6 flex max-w-md items-start gap-2.5 rounded-lg border border-subtle bg-elev px-3 py-3 text-[12.5px] leading-relaxed text-text-muted">
                    {view.kind === "favorites" ? <Heart size={16} className="mt-0.5 shrink-0" />
                      : view.kind === "playlist" ? <ListMusic size={16} className="mt-0.5 shrink-0" />
                      : <FolderOpen size={16} className="mt-0.5 shrink-0" />}
                    <div className="flex flex-col items-start gap-2.5">
                      <span>
                        {view.kind === "favorites" ? "No favorites yet. Heart a track in a folder or playlist to keep it here."
                          : view.kind === "playlist" ? "This playlist is empty. Open a folder and use ⋯, Add to playlist, on a track."
                          : "No audio in this folder. Download some into it, or add another folder."}
                      </span>
                      {view.kind === "folder" && (
                        <button onClick={() => setView({ kind: "downloads" })} className={secondaryBtn}><Download size={14} /> Add music</button>
                      )}
                    </div>
                  </div>
                )
              ) : (
                <table className="w-full border-collapse text-[12.5px]">
                  <thead>
                    <tr className="border-b border-subtle text-left text-[11.5px] text-text-muted">
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
                          className="group cursor-default transition-colors hover:bg-white/5">
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
                                <div className="truncate text-[11.5px] text-text-muted">{m.artist || "Unknown artist"}</div>
                              </div>
                            </div>
                          </td>
                          <td className="hidden truncate py-2 text-text-muted md:table-cell">{m.album}</td>
                          <td className="py-2">
                            <button onClick={() => toggleFav(m.path)} title="Favorite"
                              className="grid size-6 place-items-center rounded opacity-0 transition hover:bg-white/10 group-hover:opacity-100" style={{ opacity: isFav(m.path) ? 1 : undefined }}>
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
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// ---- left nav pieces ----
const SectionLabel = ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => (
  <div className="group mt-3 flex h-7 shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1">
    <span className={heading + " min-w-0 flex-1 truncate"}>{children}</span>
    {action && <span className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">{action}</span>}
  </div>
);

function NavItem({ icon: Icon, label, active, onClick, count, onRemove, onReveal }: {
  icon: any; label: string; active: boolean; onClick: () => void;
  count?: number; onRemove?: () => void; onReveal?: () => void;
}) {
  return (
    <div className={"group flex h-6 shrink-0 items-center gap-1 rounded-md pl-2.5 pr-1 text-[12.5px] transition-colors " +
      (active ? "text-text-primary" : "text-text-secondary hover:bg-white/5 hover:text-text-primary")}
      style={active ? { background: "var(--accent-soft)" } : undefined}>
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Icon size={14} className={"shrink-0 " + (active ? "text-text-primary" : "text-text-muted")} />
        <span className="truncate">{label}</span>
      </button>
      {(onRemove || onReveal) && (
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          {onReveal && <button onClick={onReveal} title="Reveal" className={iconBtn}><FolderOpen size={13} /></button>}
          {onRemove && <button onClick={onRemove} title="Remove from library" className={dangerBtn}><X size={13} /></button>}
        </div>
      )}
      {count != null && count > 0 && (
        <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-[10.5px] tabular-nums text-text-secondary"
          style={{ background: "var(--bg-elev)" }}>{count}</span>
      )}
    </div>
  );
}

const AddBtn = ({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) => (
  <button onClick={onClick} className="flex h-6 w-full shrink-0 items-center gap-2 rounded-md px-2.5 text-[12px] text-text-muted transition-colors hover:bg-white/5 hover:text-text-primary">
    <Icon size={13} /> {label}
  </button>
);

function RowMenu({ playlists, onAddToPlaylist, onRemoveFromPlaylist, onReveal }: {
  playlists: MusicPlaylist[];
  onAddToPlaylist: (pid: string) => void; onRemoveFromPlaylist?: () => void; onReveal: () => void;
}) {
  // Deck's menu, which flips itself when the row is near the bottom and portals out of the
  // list's overflow container.
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const items: MenuEntry[] = [
    { label: "Add to playlist", icon: ListMusic, children: playlists.length
      ? playlists.map((pl) => ({ label: pl.name, onClick: () => onAddToPlaylist(pl.id) }))
      : [{ label: "No playlists", disabled: true }] },
    "sep",
    ...(onRemoveFromPlaylist ? [{ label: "Remove from playlist", icon: X, danger: true, onClick: onRemoveFromPlaylist }] : []),
    { label: "Reveal in folder", icon: FolderOpen, onClick: onReveal },
  ];
  return (
    <>
      {/* aria-expanded tells the menu this button opened it, so pressing it again closes it. */}
      <button title="More actions" aria-haspopup="menu" aria-expanded={!!at}
        className={iconBtn + " opacity-0 group-hover:opacity-100"} style={at ? { opacity: 1 } : undefined}
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.right, y: r.bottom + 4 }); }}>
        <MoreHorizontal size={14} />
      </button>
      {at && <ContextMenu x={at.x} y={at.y} alignRight items={items} onClose={() => setAt(null)} />}
    </>
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

  const loadHistory = () => readDownloads().then((t) => { try { setHistory(t.trim() ? JSON.parse(t) : []); } catch { setHistory([]); } }).catch((e) => console.warn("[music] download history load failed", e));
  useEffect(() => {
    // Target priority: saved setting → first library folder → Windows Downloads folder.
    configRead("dl-settings").then((t) => {
      try { const d = JSON.parse(t); if (d.target) setTarget(d.target); if (d.quality) setQuality(d.quality); } catch { /* */ }
    }).catch((e) => console.warn("[music] download settings load failed", e)).finally(() => {
      setTarget((cur) => cur || folders[0]?.path || "");
      if (!folders.length) dirsDownload().then((d) => setTarget((cur) => cur || d)).catch((e) => console.warn("[music] default download folder lookup failed", e));
    });
    loadHistory();
    // Refresh history + let the collection re-scan whenever a download completes.
    const un = onDownloadDone(() => { loadHistory(); onDownloaded(); });
    return () => { un(); };
  }, []);
  useEffect(() => { configWrite("dl-settings", JSON.stringify({ target, quality })).catch((e) => console.warn("[music] download settings save failed", e)); }, [target, quality]);

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
      <h1 className="text-[20px] font-semibold text-text-primary">Add music</h1>
      <div className="rounded-lg border border-subtle p-3" style={{ background: "var(--bg-card-glass)" }}>
        <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={3}
          placeholder="Paste one or more URLs, one per line…"
          className={field + " scroll-thin block w-full resize-none px-2.5 py-2 text-text-primary"} />
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {/* Audio only. This is a music library — a downloaded video is not something anything
              else here can play, sort or tag, and the format toggle only ever offered a way to
              fill the library with files it does not understand. */}
          <select value={quality} onChange={(e) => setQuality(e.target.value)} className={field + " h-8 px-2.5 text-text-secondary"}>
            {[["0", "Best"], ["192K", "192k"], ["128K", "128k"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {/* Target folder = a library folder */}
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={field + " h-8 max-w-[200px] px-2.5 text-text-secondary"} title="Download into folder">
            {folders.length === 0 && <option value={target}>{target.split(/[\\/]/).pop() || "Downloads"}</option>}
            {folders.map((f) => <option key={f.id} value={f.path}>{f.name}</option>)}
          </select>
          {/* One accent at a time: Download while idle; while running, adding to the queue is the
              thing to do next, and Cancel is secondary (red only under the pointer). */}
          {running
            ? <button onClick={cancelEverything} className="ml-auto flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-3 text-[12.5px] text-text-secondary transition-colors hover:border-strong hover:text-red-400"><X size={14} /> Cancel</button>
            : <button onClick={start} disabled={!urls.trim()} className={primaryBtn + " ml-auto"} style={accentFill}><Download size={14} /> Download</button>}
          {running && <button onClick={start} disabled={!urls.trim()} title="Add to queue" className="grid size-8 shrink-0 place-items-center rounded-lg text-white transition hover:brightness-110 disabled:opacity-50" style={accentFill}><Plus size={14} /></button>}
        </div>
        {folders.length === 0 && <p className="mt-2 text-[11.5px] text-text-muted">Tip: add a folder in the sidebar to download into a collection.</p>}
      </div>

      {queue.length > 0 && (
        <div className="rounded-lg border border-subtle p-1.5" style={{ background: "var(--bg-card-glass)" }}>
          {queue.some((r) => r.status === "failed") && (
            <button onClick={retryFailed} className="mb-1 flex h-7 items-center gap-1.5 rounded-lg border border-subtle bg-elev px-2.5 text-[11.5px] text-text-secondary transition-colors hover:border-strong hover:text-text-primary">
              <RotateCw size={12} /> Retry all failed
            </button>
          )}
          {queue.map((r) => {
            const isPl = !!r.plCount && r.plCount !== "1"; const idx = parseInt(r.plIndex || "0") || 0; const cnt = parseInt(r.plCount || "0") || 0;
            const trackPct = parseInt(r.pct) || 0; const pct = isPl && cnt ? Math.round(((idx - 1 + trackPct / 100) / cnt) * 100) : trackPct;
            return (
              <div key={r.id} className="group rounded-md px-2.5 py-2 transition-colors hover:bg-white/5">
                <div className="flex items-center gap-2">
                  {r.status === "downloading" ? <Loader2 size={14} className="shrink-0 animate-spin text-text-secondary" /> : r.status === "done" ? <Check size={14} className="shrink-0 text-green-400" /> : r.status === "failed" ? <X size={14} className="shrink-0 text-red-400" /> : <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-strong" />}
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-primary">{isPl ? `${r.plTitle || "Playlist"} — ${idx}/${cnt}` : r.title}</span>
                  {r.status === "downloading" && <span className="shrink-0 text-[11px] tabular-nums text-text-muted">{r.speed} · {r.eta}</span>}
                  {r.status === "downloading" && <button onClick={() => cancelOne(r.id)} title="Cancel" className={dangerBtn + " opacity-0 group-hover:opacity-100"}><X size={13} /></button>}
                  {r.status === "failed" && <button onClick={() => retryOne(r.id)} title="Retry" className={iconBtn}><RotateCw size={13} /></button>}
                </div>
                {(r.status === "downloading" || r.status === "queued") && <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--bg-elev)" }}><div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--accent)" }} /></div>}
                {r.status === "failed" && <p className="mt-1 truncate pl-[22px] text-[11px] text-red-400">{r.error}</p>}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border border-subtle p-1.5" style={{ background: "var(--bg-card-glass)" }}>
        <div className={heading + " flex h-7 items-center px-2.5"}>Recent downloads</div>
        {history.length === 0 ? <p className="px-2.5 pb-2 pt-1 text-[12px] text-text-muted">Nothing downloaded yet. Paste a link above and press Download.</p> : (
          <div>
            {history.slice(0, 30).map((h) => (
              <div key={h.id} className="group flex h-6 items-center gap-2 rounded-md px-2.5 transition-colors hover:bg-white/5">
                {h.status === "done" ? <Check size={13} className="shrink-0 text-green-400" /> : <AlertTriangle size={13} className="shrink-0 text-red-400" />}
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary group-hover:text-text-primary">{h.title}</span>
                <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  {h.status === "failed" && h.url && <button onClick={() => enqueue([{ url: h.url, title: h.title }], target, h.quality || "0")} title="Retry" className={iconBtn}><RotateCw size={13} /></button>}
                  {h.filePath && h.status === "done" && <button onClick={() => player.play([{ path: h.filePath!, title: h.title }], 0)} title="Play" className={iconBtn}><Play size={13} /></button>}
                  {h.filePath && <button onClick={() => revealInFolder(h.filePath!)} title="Reveal" className={iconBtn}><FolderOpen size={13} /></button>}
                </div>
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
    } catch (e) { console.warn("[music] preview stream resolve failed", e); /* resolve failed */ }
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
    readMusicTaste().then((md) => { setTaste(md); setManual(splitTaste(md).manual.trim()); }).catch((e) => console.warn("[music] taste load failed", e));
    configRead("dl-settings").then((t) => { try { const d = JSON.parse(t); if (d.target) setTarget(d.target); } catch { /* */ } }).catch((e) => console.warn("[music] download settings load failed", e));
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
        configWrite("music-thumbs", JSON.stringify({ gen, thumbs })).catch((e) => console.warn("[music] thumbnails save failed", e));
      }).catch((e) => console.warn("[music] thumbnails fetch failed", e));
    }).catch((e) => console.warn("[music] thumbnails load failed", e));
    return () => { cancelled = true; };
  }, [sugg?.generated_at]);

  const discover = async () => {
    setDiscovering(true); setChecked({});
    await musicDiscover(count).catch((e) => { console.warn("[music] discover failed", e); setDiscovering(false); });
    // result lands in music-suggestions.json after ~40s; the poll picks it up. Stop spinner after 3min max.
    setTimeout(() => setDiscovering(false), 180_000);
  };

  const saveManual = () => {
    const { auto } = splitTaste(taste);
    const head = auto || "# Music taste\n\n<!-- AUTO: Claude maintains this. -->\n(pending)\n<!-- /AUTO -->";
    const merged = `${head}\n\n<!-- MANUAL: write anything you like — artists, genres, moods. Claude never edits this. -->\n${manual.trim()}\n`;
    setTaste(merged); writeMusicTaste(merged).catch((e) => console.warn("[music] taste save failed", e));
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
        <Sparkles size={18} className="text-text-muted" />
        <h1 className="text-[20px] font-semibold text-text-primary">Discover</h1>
        {sugg && <span className="text-[11.5px] text-text-muted">updated {relDays(sugg.generated_at)}</span>}
      </div>

      {/* Taste profile — MANUAL block editable, AUTO shown read-only */}
      <div className="rounded-lg border border-subtle p-3" style={{ background: "var(--bg-card-glass)" }}>
        <div className={heading + " mb-2"}>Your taste</div>
        {splitTaste(taste).auto && (
          <p className="mb-2.5 whitespace-pre-wrap rounded-lg border border-subtle bg-elev p-2.5 text-[12px] leading-relaxed text-text-secondary">
            {splitTaste(taste).auto.replace(/<!--.*?-->/gs, "").replace(/^#.*$/gm, "").trim()}
          </p>
        )}
        <textarea value={manual} onChange={(e) => setManual(e.target.value)} onBlur={saveManual} rows={3}
          placeholder="Add your own notes — favourite artists, genres, moods you want more of…"
          className={field + " scroll-thin block w-full resize-none px-2.5 py-2 text-text-primary"} />
      </div>

      {/* Discover controls. The accent goes to what comes next: Discover until there are songs,
          then Download selected. */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={count} onChange={(e) => setCount(Number(e.target.value))} className={field + " h-8 px-2.5 text-text-secondary"}>
          {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n} songs</option>)}
        </select>
        <select value={target} onChange={(e) => setTarget(e.target.value)} className={field + " h-8 max-w-[200px] px-2.5 text-text-secondary"} title="Download into folder">
          {folders.length === 0 && <option value="">No folder — add one first</option>}
          {folders.map((f) => <option key={f.id} value={f.path}>{f.name}</option>)}
        </select>
        <button onClick={discover} disabled={discovering}
          className={songs.length ? secondaryBtn : primaryBtn} style={songs.length ? undefined : accentFill}>
          {discovering ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {discovering ? "Finding songs…" : sugg ? "Refresh" : "Discover"}
        </button>
        {songs.length > 0 && (
          <>
            <button onClick={toggleAll} className={secondaryBtn}>
              {songs.every((s) => checked[s.id]) ? "Clear" : "Select all"}
            </button>
            <button onClick={downloadSelected} disabled={!anyChecked || !target}
              className={primaryBtn + " ml-auto"} style={accentFill}>
              {sent ? <Check size={14} /> : <Download size={14} />}
              {sent ? "Sent to Downloads" : "Download selected"}
            </button>
          </>
        )}
      </div>

      {discovering && songs.length === 0 && (
        <div className="flex items-center gap-2 px-1 py-6 text-[12.5px] text-text-muted"><Loader2 size={14} className="animate-spin" /> The AI is searching for new songs in your taste… (~40s)</div>
      )}
      {!discovering && songs.length === 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-subtle bg-elev px-3 py-3 text-[12.5px] leading-relaxed text-text-muted">
          <Sparkles size={16} className="mt-0.5 shrink-0" />
          <span>No suggestions yet. Say what you like under Your taste, then press Discover for songs to try.</span>
        </div>
      )}

      {/* Suggestion cards */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {songs.map((s) => {
          const thumb = thumbs[s.id];
          const got = isDownloaded(s);
          return (
            <label key={s.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-subtle p-3 transition-colors hover:border-strong"
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
                  <span className="truncate text-[12.5px] font-medium" style={{ color: isPlaying(s.id) ? "var(--accent)" : "var(--text-primary)" }}>{s.title}</span>
                  {got && <span className="flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10.5px]" style={chip("rgb(var(--tone-green-400))")}><Check size={10} /> Got it</span>}
                </div>
                <div className="truncate text-[11.5px] text-text-muted">{s.artist}</div>
                <div className="mt-1 text-[11.5px] leading-snug text-text-secondary">{s.why}</div>
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
