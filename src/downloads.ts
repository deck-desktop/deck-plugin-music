// Persistent download store — lives outside the React tree so an in-flight download
// stays visible when you switch tabs (the Music module unmounts, this doesn't).
// The Rust side actually runs yt-dlp and emits `download-progress`; this mirrors it.
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {readDownloads, writeDownloads, type DownloadItem} from "./library";
import { downloadMedia, cancelDownload, type DownloadProgress } from "./music-rust";

export type QueueRow = {
  id: string; url: string; title: string; quality: string; dir: string;
  pct: string; speed: string; eta: string;
  plIndex?: string; plCount?: string; plTitle?: string;
  status: "queued" | "downloading" | "done" | "failed"; filePath?: string; error?: string;
};

const newId = () => `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

type State = { queue: QueueRow[]; running: boolean };
let state: State = { queue: [], running: false };
let cancelAll = false;
const subs = new Set<() => void>();
// Fires after a download finishes OK, so views can refresh (e.g. re-scan a folder).
const doneSubs = new Set<() => void>();

const emit = () => { state = { ...state }; subs.forEach((f) => f()); };
const setQueue = (fn: (q: QueueRow[]) => QueueRow[]) => { state.queue = fn(state.queue); emit(); };

// Single, always-on progress listener — updates the matching row live.
const unProgress = listen<DownloadProgress>("download-progress", (e) => {
  const p = e.payload;
  setQueue((rs) => rs.map((r) => r.id === p.id
    ? { ...r, pct: p.pct || r.pct, speed: p.speed, eta: p.eta, title: p.title || r.title,
        plIndex: p.plIndex || r.plIndex, plCount: p.plCount || r.plCount, plTitle: p.plTitle || r.plTitle, status: "downloading" }
    : r));
});
unProgress.catch(() => {});

/** Stop listening. Deck calls this (through the plugin's `dispose`) before a reload re-imports it. */
export function disposeDownloads() {
  void unProgress.then((un) => un()).catch(() => {});
}

async function appendHistory(item: DownloadItem) {
  let h: DownloadItem[] = [];
  try { const t = await readDownloads(); h = t.trim() ? JSON.parse(t) : []; } catch (e) { console.warn("[music] download history read failed", e); }
  await writeDownloads(JSON.stringify([item, ...h].slice(0, 200))).catch((e) => console.warn("[music] download history save failed", e));
}

// Drain queued rows sequentially (one at a time). Each row carries its own dir/format/
// quality, so retried rows and mid-run additions download with their own settings.
async function drain() {
  if (state.running) return;               // an active loop will pick up new/retried rows
  state.running = true; emit();
  for (;;) {
    const row = state.queue.find((r) => r.status === "queued");
    if (!row || cancelAll) break;
    setQueue((rs) => rs.map((r) => r.id === row.id ? { ...r, status: "downloading" } : r));
    try {
      const res = await downloadMedia(row.id, row.url, row.quality, row.dir);
      setQueue((rs) => rs.map((r) => r.id === row.id
        ? { ...r, status: res.ok ? "done" : "failed", pct: res.ok ? "100%" : r.pct, title: res.title || r.title, filePath: res.filePath, error: res.error }
        : r));
      await appendHistory({ id: row.id, url: row.url, title: res.title || row.title, quality: row.quality, filePath: res.filePath || undefined, sizeBytes: res.sizeBytes || undefined, status: res.ok ? "done" : "failed", at: Date.now() });
      if (res.ok) doneSubs.forEach((f) => f());
    } catch (e) {
      setQueue((rs) => rs.map((r) => r.id === row.id ? { ...r, status: "failed", error: String(e) } : r));
    }
  }
  state.running = false; emit();
}

// Enqueue items and process sequentially (one download at a time, as before).
export async function enqueue(items: { url: string; title: string }[], dir: string, quality = "0") {
  if (!items.length || !dir) return;
  cancelAll = false;
  const rows: QueueRow[] = items.map((it) => ({ id: newId(), url: it.url, title: it.title, quality, dir, pct: "0%", speed: "", eta: "", status: "queued" }));
  setQueue((q) => [...rows, ...q]);
  drain();
}

// Re-queue a failed row and kick the drain loop.
export function retryOne(id: string) {
  cancelAll = false;
  setQueue((rs) => rs.map((r) => r.id === id && r.status === "failed"
    ? { ...r, status: "queued", pct: "0%", speed: "", eta: "", error: undefined } : r));
  drain();
}

// Re-queue every failed row at once.
export function retryFailed() {
  cancelAll = false;
  setQueue((rs) => rs.map((r) => r.status === "failed"
    ? { ...r, status: "queued", pct: "0%", speed: "", eta: "", error: undefined } : r));
  drain();
}

export function cancelOne(id: string) { cancelDownload(id).catch(() => {}); }
export function cancelEverything() {
  cancelAll = true;
  state.queue.filter((r) => r.status === "downloading").forEach((r) => cancelDownload(r.id).catch(() => {}));
}
export function clearFinished() { setQueue((rs) => rs.filter((r) => r.status === "downloading" || r.status === "queued")); }

export function onDownloadDone(fn: () => void) { doneSubs.add(fn); return () => doneSubs.delete(fn); }

// React binding — components re-render when the store changes.
export function useDownloads() {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => state,
  );
}
