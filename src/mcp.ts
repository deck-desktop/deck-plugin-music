// The agent-facing tools for this plugin's data.
//
// Moved out of the MCP server for the same reason the tab moved out of Deck: this plugin owns
// downloading, so the tool that downloads belongs beside it.
//
// It also settles something the server's copy had to apologise for. That copy carried a note
// saying the yt-dlp flags were deliberately duplicated from the plugin, because the server "must
// work whether or not the plugin is installed". Here that tension is gone: a Deck without the
// music plugin simply has no download tool — which is the truth, rather than a tool that
// downloads into a library nothing will ever list.
//
// The flags live once, in ytdlp.ts, shared with the UI's download. They did NOT when this file
// was written, and the two had already drifted: this copy was missing --windows-filenames, so an
// agent download of a title containing ? or : failed with Errno 22 where the same download from
// the UI succeeded. It also offered mp4, which the UI does not — a video file being something
// nothing else in a music library can play, sort or tag.
//
// Node builtins ARE imported here, unlike zod and the store helpers. A plugin's mcp.js is loaded
// by the MCP server's own Node process, so `node:child_process` resolves; `zod` would not,
// because it lives in the server's node_modules rather than beside the plugin.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeckMcp, McpServer } from "../shim/mcp.js";
import { ytdlpArgs } from "./ytdlp";

interface DlSettings { target?: string; quality?: string }

export function register(server: McpServer, deck: DeckMcp) {
  const { z, ok, readJson } = deck;

  server.tool(
    "deck_download_music",
    "Download audio from a URL (YouTube etc.) via yt-dlp into Deck's music download folder, " +
      "as mp3. Quality and target folder default to Deck's download settings. A `list=` URL " +
      "downloads the whole playlist. Blocks until done.",
    {
      url: z.string().url(),
      quality: z.string().optional().describe("0 (best) | 192K | 128K"),
      outDir: z.string().optional().describe("override the download folder"),
    },
    async ({ url, quality, outDir }) => {
      const dl = readJson<DlSettings>("dl-settings", {});
      const q = quality ?? dl.quality ?? "0";
      const dir = outDir ?? dl.target ?? join(homedir(), "Downloads");

      // No progress flags: this waits for the process to exit and reads stdout once, so the
      // streaming template would only be noise to filter back out.
      const args = ytdlpArgs({ url, dir, quality: q, progress: false });

      return await new Promise((resolve) => {
        // 30-min cap covers big playlists; a hung yt-dlp still returns instead of wedging.
        execFile("python", args, { timeout: 30 * 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) {
            const line = (stderr || err.message).trim().split("\n").pop() ?? "download failed";
            resolve(ok(`Download failed: ${line}`));
            return;
          }
          const files = stdout.trim().split("\n").filter(Boolean);
          resolve(ok(files.length ? `Downloaded ${files.length} file(s):\n${files.join("\n")}` : `Downloaded to ${dir}.`));
        });
      });
    },
  );
}
