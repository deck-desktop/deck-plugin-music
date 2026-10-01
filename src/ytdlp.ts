// How to ask yt-dlp for a download, with no filesystem and no Deck.
//
// A separate file for the same reason sort.ts is: it is pure, so both callers can import it —
// the UI's download (music-rust.ts, which hands the argv to Rust for streaming) and the agent's
// (mcp.ts, which runs it with node:child_process). They differ in how they RUN yt-dlp, not in
// what they ask it for, and that difference is the whole reason this had drifted.
//
// It had drifted in a way worth naming: the MCP copy was missing --windows-filenames, so an
// agent download of a search-result title containing ? or : failed with Errno 22 while the same
// download from the UI succeeded. One copy of the argv is how that stops happening again.

export interface DlOptions {
  url: string;
  /** Absolute output folder. Callers resolve it — this function never touches the disk. */
  dir: string;
  /** Audio quality: 0 (best) | 192K | 128K. */
  quality: string;
  /**
   * Emit the progress/title/done protocol music-rust.ts parses off `proc-line`.
   *
   * Off for the agent, which waits for the process to exit and reads its stdout once — the
   * --newline progress stream would just be noise it has to filter back out.
   */
  progress?: boolean;
}

/** Strip ?si= tracking but keep list= — that is what makes a URL a playlist. */
export function cleanUrl(url: string): string {
  const parts = String(url).split(/[?&]/).filter((p, i) => i === 0 || !p.startsWith("si="));
  return parts.length <= 1 ? parts.join("") : `${parts[0]}?${parts.slice(1).join("&")}`;
}

/** Where the files land. A playlist gets its own folder, numbered in order. */
export function outputTemplate(dir: string, isPlaylist: boolean): string {
  return isPlaylist
    ? `${dir}\\%(playlist_title)s\\%(playlist_index)s - %(title)s.%(ext)s`
    : `${dir}\\%(title)s.%(ext)s`;
}

/**
 * The full argv after `python`, ready to spawn.
 *
 * `dir` must already be absolute: left relative, yt-dlp resolves it against ITS OWN working
 * directory and the files land somewhere nothing afterwards looks.
 */
export function ytdlpArgs(opts: DlOptions): string[] {
  const clean = cleanUrl(opts.url);
  const isPlaylist = clean.includes("list=");

  const args = ["-m", "yt_dlp", "--no-warnings", "--no-overwrites"];

  if (opts.progress) {
    args.push(
      "--newline",
      "--progress-template",
      "PROG\t%(progress._percent_str)s\t%(progress._speed_str)s\t%(progress._eta_str)s\t%(info.playlist_index)s\t%(info.playlist_count)s\t%(info.playlist_title)s",
      "--print", "before_dl:TITLE\t%(title)s\t%(playlist_index)s\t%(playlist_count)s\t%(playlist_title)s",
      "--print", "after_move:DONE\t%(filepath)s",
    );
  } else {
    // The agent only needs to know what landed, so it prints paths and nothing else.
    args.push("--print", "after_move:%(filepath)s");
  }

  // Search-query titles can carry characters Windows rejects, which surfaces as Errno 22.
  args.push("--windows-filenames", "--embed-metadata", "--embed-thumbnail");

  // mp3 always. This is a music library, and a video file is something nothing else here can
  // play, sort or tag — so there is no format to choose and no parameter for one.
  args.push("-f", "bestaudio/best", "--extract-audio", "--audio-format", "mp3",
    "--audio-quality", opts.quality);

  args.push(...(isPlaylist ? ["--yes-playlist", "--ignore-errors"] : ["--no-playlist"]));
  args.push("--output", outputTemplate(opts.dir, isPlaylist), clean);
  return args;
}
