// The six calls Deck no longer provides, rebuilt on its generic primitives.
//
// Each of these used to be a command in music.rs. They are here because they are music knowledge,
// not platform capability: how yt-dlp formats a progress line, which extensions count as audio.
// Deck contributes proc_stream and fs_list; the rest is this plugin's
// business. The download flags themselves are in ytdlp.ts, shared with the agent-facing tool.
import {
  procStream, procKill, fsList, vaultDataRead, vaultDataWrite,
} from "../shim/bridge.js";
import { listen } from "@tauri-apps/api/event";
import { ytdlpArgs } from "./ytdlp";

// Audio only: this is a music library, and a video file is something nothing else here can
// play, sort or tag. There is no format to choose, so there is no parameter for one.

export interface DownloadResult {
  id: string; ok: boolean; title: string;
  filePath: string; sizeBytes: number; error: string;
}

/** What the UI shows while a download runs. Same shape the Rust command emitted. */
export interface DownloadProgress {
  id: string; pct: string; speed: string; eta: string; title: string; stage: string;
  plIndex: string; plCount: string; plTitle: string;
}

const AUDIO_EXT = ["mp3", "m4a", "opus", "flac", "wav", "webm", "aac", "ogg"];

/** yt-dlp prints "NA" for a field that does not apply; the UI wants an empty string. */
const na = (s: string) => (s === "NA" ? "" : s);

/**
 * Audio files directly inside a folder, as absolute paths.
 *
 * fs_list plus a filter, where list_audio_files was a command. The extension list is music's to
 * know, which is exactly why this moved.
 */
export async function listAudioFiles(dir: string): Promise<string[]> {
  const entries = await fsList(dir);
  return entries
    .filter((e) => !e.dir && AUDIO_EXT.includes(e.name.toLowerCase().split(".").pop() ?? ""))
    .map((e) => e.path);
}

/**
 * Download with yt-dlp, reporting progress as it goes.
 *
 * This is download_media's body: Deck now only spawns a process and streams its lines, so the
 * TITLE/PROG/DONE protocol is parsed here. The flags that produce it are in ytdlp.ts, shared
 * with the agent-facing download.
 *
 * `onProgress` is called for each update. The returned promise settles when the process exits.
 */
export async function downloadMedia(
  id: string, url: string, quality: string, outDir: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  const dir = outDir;
  // Shared with the agent's download in mcp.ts. The two run yt-dlp differently — this streams
  // through Rust, that one waits on execFile — but they ask it for the same thing.
  const args = ytdlpArgs({ url, dir, quality, progress: true });

  let title = "";
  let filePath = "";
  let plIndex = "", plCount = "", plTitle = "";

  // Only this run's lines: proc-line is one event for every process Deck is streaming.
  const un = await listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    if (e.payload.id !== id || e.payload.stream !== "stdout") return;
    const line = e.payload.line;
    if (line.startsWith("TITLE\t")) {
      const p = line.slice(6).split("\t");
      title = p[0] ?? "";
      [plIndex, plCount, plTitle] = [na(p[1] ?? ""), na(p[2] ?? ""), na(p[3] ?? "")];
      onProgress?.({ id, pct: "0%", speed: "", eta: "", title, stage: "start", plIndex, plCount, plTitle });
    } else if (line.startsWith("PROG\t")) {
      const p = line.slice(5).split("\t");
      onProgress?.({
        id, pct: (p[0] ?? "").trim(), speed: (p[1] ?? "").trim(), eta: (p[2] ?? "").trim(),
        title, stage: "downloading",
        plIndex: na((p[3] ?? "").trim()), plCount: na((p[4] ?? "").trim()), plTitle: na((p[5] ?? "").trim()),
      });
    } else if (line.startsWith("DONE\t")) {
      filePath = line.slice(5);
    }
  });

  try {
    const r = await procStream(id, "python", args, "");

    return {
      id, ok: r.code === 0 && !r.cancelled, title,
      filePath, sizeBytes: 0,
      error: r.cancelled ? "cancelled" : r.code === 0 ? "" : exitReason(r.code, !!title),
    };
  } catch (e) {
    // procStream rejects when the program itself could not start, which for `python` means it
    // is not on PATH. Raw, that surfaces in the queue row as a Tauri spawn error naming a
    // program the user never typed.
    return { id, ok: false, title, filePath: "", sizeBytes: 0, error: missingPython(e) };
  } finally {
    un();
  }
}

/**
 * Why a download failed, for the line under the row.
 *
 * The exit code alone said "yt-dlp exited 1", which is wrong twice over when yt-dlp is not
 * installed: Python ran, yt-dlp did not, and the message names the thing that never started.
 * `-m yt_dlp` exits 1 for a missing module and for an ordinary download failure alike, so the
 * two are told apart by whether anything was parsed off stdout first — a real download reports
 * its title before it can fail.
 */
export function exitReason(code: number, gotTitle: boolean): string {
  if (code === 1 && !gotTitle) {
    return "yt-dlp did not run — install it with: pip install -U yt-dlp";
  }
  return `yt-dlp exited ${code}`;
}

/** A spawn failure for `python`, said in terms of what is missing. */
export function missingPython(e: unknown): string {
  const raw = String(e);
  // Only claim "no Python" for a spawn failure. Anything else is a different problem and its
  // own message is more useful than a guess.
  return /not found|cannot find|No such file|os error 2|ENOENT/i.test(raw)
    ? "Python is not on PATH — music downloads need Python with yt-dlp installed"
    : raw;
}

/** Cancel a running download. procKill takes the same id downloadMedia was given. */
export const cancelDownload = (id: string) => procKill(id);

/**
 * A playable stream URL for a search query or page URL, via yt-dlp's -g.
 *
 * One line of output, so proc_stream's event is collected rather than streamed.
 */
export async function resolveStreamUrl(query: string): Promise<string> {
  const id = `resolve-${Date.now()}`;
  let out = "";
  const un = await listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    if (e.payload.id === id && e.payload.stream === "stdout" && !out) out = e.payload.line.trim();
  });
  try {
    const r = await procStream(id, "python",
      ["-m", "yt_dlp", "-g", "-f", "bestaudio/best", "--no-playlist", "--no-warnings", query], "");
    if (r.code !== 0 || !out) throw new Error(`could not resolve a stream for "${query}"`);
    return out;
  } finally {
    un();
  }
}

/**
 * Cover art for a list of search queries — yt-dlp's thumbnail for the first result of each.
 *
 * One process per query, as the Rust version did, but run concurrently rather than in sequence:
 * each is a network round trip, and Discover asks for a whole grid at once. A query that fails
 * yields "", which the UI already renders as a placeholder.
 */
export async function musicThumbs(queries: string[]): Promise<string[]> {
  return Promise.all(queries.map(async (q, i) => {
    const id = `thumb-${Date.now()}-${i}`;
    let url = "";
    const un = await listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
      if (e.payload.id === id && e.payload.stream === "stdout" && !url) url = e.payload.line.trim();
    });
    try {
      const r = await procStream(id, "python",
        ["-m", "yt_dlp", "--print", "thumbnail", "--no-warnings", "--no-playlist", `ytsearch1:${q}`], "");
      return r.code === 0 ? url : "";
    } catch {
      return "";
    } finally {
      un();
    }
  }));
}

// The discovery prompt. It lives here, in the plugin, because it IS the feature — a music
// plugin that could not decide what to ask for would not be one. Ported from the VPS script
// /opt/deck-brain-config/run-music-discover.sh, which ran the same prompt through headless
// Claude over ssh.
//
// Two blocks in the taste file: AUTO, which the model rewrites from the library each run, and
// MANUAL, which is the user's own words and is never touched. MANUAL is weighted heavily because
// an inference from filenames is a guess and a stated preference is not.
const DISCOVER_PROMPT = (taste: string, libNames: string, count: number) =>
  `You are a music-discovery agent. Use web search for CURRENT information.

The listener's taste profile (AUTO block is your own earlier inference, MANUAL block is their own
words — weight MANUAL heavily):
---
${taste}
---

Filenames sampled from their music library (artist/title hints):
---
${libNames || "none yet"}
---

TASKS:
1. Update the taste: write a concise 4-8 line summary of their taste (genres, artists, moods)
   based on the library filenames plus the existing profile. This becomes the new AUTO block.
2. Suggest exactly ${count} NEW / recently-popular songs they would likely enjoy but probably do
   NOT already have (avoid the sampled filenames). Prefer songs from the last few months when
   relevant. Each: title, artist, one short reason.

Output ONLY a JSON object, no prose, no markdown fence:
{"taste_auto": "<the 4-8 line summary>", "songs": [{"title":"..","artist":"..","why":".."}]}`;

/** The taste file as it starts out: an AUTO block the model owns, a MANUAL block the user owns. */
const TASTE_SEED = `# Music taste

<!-- AUTO: Claude maintains this block from your library. Do not edit by hand. -->
(no library scanned yet)
<!-- /AUTO -->

<!-- MANUAL: write anything you like below — artists, genres, moods. Claude never edits this. -->

`;

/** Replace the AUTO block, leaving MANUAL exactly as the user wrote it. */
function updateAutoBlock(taste: string, auto: string): string {
  const start = taste.indexOf("<!-- AUTO:");
  const endMark = "<!-- /AUTO -->";
  const end = taste.indexOf(endMark);
  if (start < 0 || end < 0 || end < start) return taste;
  const head = taste.slice(0, taste.indexOf("\n", start) + 1);
  return head + auto + "\n" + taste.slice(end);
}

/**
 * Ask Claude for fresh listening suggestions, and refresh the taste profile from the library.
 *
 * Runs LOCALLY: Deck spawns the agent through proc_stream, the same way it runs yt-dlp. This
 * used to ssh to the VPS and run a script there, which meant the prompt — the actual substance
 * of the feature — lived in a file no copy of Deck had. Now the plugin owns it.
 *
 * Resolves when suggestions have been written, unlike the old detached ssh call which returned
 * as soon as the job started. The run takes roughly 40 seconds.
 */
export async function musicDiscover(count: number): Promise<void> {
  const n = Math.min(30, Math.max(1, Math.floor(count)));

  const taste = (await vaultDataRead("music-taste.md").catch(() => "")) || TASTE_SEED;

  // Filenames as taste hints: folder names, favorites and playlist tracks, stripped of their
  // directory and extension. Capped, because the prompt has to stay a prompt.
  const libRaw = await vaultDataRead("music-library.json").catch(() => "");
  let libNames = "";
  try {
    const lib = JSON.parse(libRaw || "{}");
    const names: string[] = [
      ...(lib.folders ?? []).map((f: { name?: string }) => f.name ?? ""),
      ...(lib.favorites ?? []),
      ...(lib.playlists ?? []).flatMap((p: { tracks?: string[] }) => p.tracks ?? []),
    ];
    libNames = [...new Set(names
      .map((p) => p.split(/[\\/]/).pop() ?? "")
      .map((p) => p.replace(/\.[a-zA-Z0-9]+$/, ""))
      .filter(Boolean))].sort().slice(0, 80).join("\n");
  } catch { /* no library yet is fine — the prompt says "none yet" */ }

  const id = `music-discover-${Date.now()}`;
  let out = "";
  const un = await listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    if (e.payload.id === id && e.payload.stream === "stdout") out += e.payload.line + "\n";
  });

  try {
    // --dangerously-skip-permissions because this is headless with nobody to answer a prompt,
    // and the agent only reads a taste file and searches the web.
    const r = await procStream(id, "claude",
      ["-p", DISCOVER_PROMPT(taste, libNames, n), "--dangerously-skip-permissions"], "");
    if (r.code !== 0) throw new Error(`the discovery agent exited ${r.code}`);

    // Take the outermost JSON object, tolerating a stray markdown fence around it.
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("the model did not return JSON");
    const parsed = JSON.parse(out.slice(start, end + 1)) as {
      taste_auto?: string;
      songs?: { title?: string; artist?: string; why?: string }[];
    };

    // Written only after the parse succeeds: a failed run must leave the previous suggestions
    // in place rather than replacing them with nothing.
    const songs = (parsed.songs ?? []).map((s, i) => ({
      id: `s${i}`, title: s.title ?? "", artist: s.artist ?? "", why: s.why ?? "",
    }));
    await vaultDataWrite("music-suggestions.json",
      JSON.stringify({ generated_at: Date.now(), songs }, null, 2));

    if (parsed.taste_auto) {
      await vaultDataWrite("music-taste.md", updateAutoBlock(taste, parsed.taste_auto));
    }
  } finally {
    un();
  }
}
