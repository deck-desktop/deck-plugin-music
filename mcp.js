// src/mcp.ts
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// src/ytdlp.ts
function cleanUrl(url) {
  const parts = String(url).split(/[?&]/).filter((p, i) => i === 0 || !p.startsWith("si="));
  return parts.length <= 1 ? parts.join("") : `${parts[0]}?${parts.slice(1).join("&")}`;
}
function outputTemplate(dir, isPlaylist) {
  return isPlaylist ? `${dir}\\%(playlist_title)s\\%(playlist_index)s - %(title)s.%(ext)s` : `${dir}\\%(title)s.%(ext)s`;
}
function ytdlpArgs(opts) {
  const clean = cleanUrl(opts.url);
  const isPlaylist = clean.includes("list=");
  const args = ["-m", "yt_dlp", "--no-warnings", "--no-overwrites"];
  if (opts.progress) {
    args.push(
      "--newline",
      "--progress-template",
      "PROG	%(progress._percent_str)s	%(progress._speed_str)s	%(progress._eta_str)s	%(info.playlist_index)s	%(info.playlist_count)s	%(info.playlist_title)s",
      "--print",
      "before_dl:TITLE	%(title)s	%(playlist_index)s	%(playlist_count)s	%(playlist_title)s",
      "--print",
      "after_move:DONE	%(filepath)s"
    );
  } else {
    args.push("--print", "after_move:%(filepath)s");
  }
  args.push("--windows-filenames", "--embed-metadata", "--embed-thumbnail");
  args.push(
    "-f",
    "bestaudio/best",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    opts.quality
  );
  args.push(...isPlaylist ? ["--yes-playlist", "--ignore-errors"] : ["--no-playlist"]);
  args.push("--output", outputTemplate(opts.dir, isPlaylist), clean);
  return args;
}

// src/mcp.ts
function register(server, deck) {
  const { z, ok, readJson } = deck;
  server.tool(
    "deck_download_music",
    "Download audio from a URL (YouTube etc.) via yt-dlp into Deck's music download folder, as mp3. Quality and target folder default to Deck's download settings. A `list=` URL downloads the whole playlist. Blocks until done.",
    {
      url: z.string().url(),
      quality: z.string().optional().describe("0 (best) | 192K | 128K"),
      outDir: z.string().optional().describe("override the download folder")
    },
    async ({ url, quality, outDir }) => {
      const dl = readJson("dl-settings", {});
      const q = quality ?? dl.quality ?? "0";
      const dir = outDir ?? dl.target ?? join(homedir(), "Downloads");
      const args = ytdlpArgs({ url, dir, quality: q, progress: false });
      return await new Promise((resolve) => {
        execFile("python", args, { timeout: 30 * 6e4, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            const line = (stderr || err.message).trim().split("\n").pop() ?? "download failed";
            resolve(ok(`Download failed: ${line}`));
            return;
          }
          const files = stdout.trim().split("\n").filter(Boolean);
          resolve(ok(files.length ? `Downloaded ${files.length} file(s):
${files.join("\n")}` : `Downloaded to ${dir}.`));
        });
      });
    }
  );
}
export {
  register
};
