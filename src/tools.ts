// What the music plugin needs on PATH, and whether it is there.
//
// Downloads shell out rather than bundling a downloader: yt-dlp is the only thing that keeps up
// with the sites it reads, and shipping a copy would mean shipping a stale one. So the plugin
// depends on two programs it does not install, and the settings panel has to be able to say
// which are missing — a note that always says "you need ffmpeg" is no use to someone who has it.
//
// Checked here rather than by Deck: these belong to this plugin. Deck's first-run screen used to
// probe them, which meant core knew about a plugin's dependencies and reported on them before
// anyone had opened Music.
import { procStream } from "../shim/bridge.js";
import { listen } from "@tauri-apps/api/event";

export interface ToolState {
  /** Present and runnable. */
  ok: boolean;
  /** A version line when found, or why not. */
  detail: string;
}

export interface ToolReport {
  python: ToolState;
  ytdlp: ToolState;
  ffmpeg: ToolState;
}

/**
 * Run one program and collect its first line of output.
 *
 * procStream is an event stream — one `proc-line` per line — so this subscribes, filters on its
 * own id, and resolves when the process exits. A spawn failure rejects, which is the "not on
 * PATH" case and is caught by the caller.
 */
async function firstLine(program: string, args: string[]): Promise<string> {
  const id = `music-probe-${program}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let out = "";
  const un = await listen<{ id: string; stream: string; line: string }>("proc-line", (e) => {
    // stderr as well as stdout: ffmpeg -version writes its banner to stdout, but several
    // builds put the first line on stderr, and "found" should not depend on which.
    if (e.payload.id !== id || out) return;
    const line = e.payload.line.trim();
    if (line) out = line;
  });
  try {
    const r = await procStream(id, program, args, "");
    if (r.code !== 0) throw new Error(out || `exited ${r.code}`);
    return out;
  } finally {
    un();
  }
}

const found = (detail: string): ToolState => ({ ok: true, detail });
const missing = (detail: string): ToolState => ({ ok: false, detail });

/**
 * Probe all three, concurrently.
 *
 * Python is its own row because yt-dlp is run as a MODULE (`python -m yt_dlp`), so "no Python"
 * and "Python without the package" are different problems with different fixes — and reporting
 * only "yt-dlp is missing" for the first sends people to install the wrong thing.
 */
export async function checkTools(): Promise<ToolReport> {
  const [python, ytdlp, ffmpeg] = await Promise.all([
    firstLine("python", ["--version"])
      .then((v) => found(v))
      .catch(() => missing("not on PATH")),
    firstLine("python", ["-m", "yt_dlp", "--version"])
      .then((v) => found(`yt-dlp ${v}`))
      .catch(() => missing("not installed")),
    firstLine("ffmpeg", ["-version"])
      .then((v) => found(v))
      .catch(() => missing("not on PATH")),
  ]);
  // yt-dlp cannot be present without Python, and saying "not installed" there would point at
  // the wrong fix. The Python row already says what is actually wrong.
  return {
    python,
    ytdlp: python.ok ? ytdlp : missing("needs Python first"),
    ffmpeg,
  };
}

/** The command that fixes a row, or "" when there is nothing to fix. */
export function fixFor(tool: keyof ToolReport, report: ToolReport): string {
  if (report[tool].ok) return "";
  switch (tool) {
    // winget ships with Windows 11, which makes it the one installer that can be assumed.
    case "python": return "winget install --id Python.Python.3.13 -e";
    case "ytdlp": return report.python.ok ? "pip install -U yt-dlp" : "";
    case "ffmpeg": return "winget install --id Gyan.FFmpeg -e";
  }
}
