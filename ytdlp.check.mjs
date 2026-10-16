// node ytdlp.check.mjs
//
// The UI's download and the agent's ask yt-dlp for the same thing. They did not always: the MCP
// copy of the argv had drifted and lost --windows-filenames, so an agent download of a title
// containing ? or : failed with Errno 22 where the same download from the UI succeeded. This is
// the check that would have caught it.
//
// It compiles the real ytdlp.ts rather than holding its own copy — a check with a copy cannot
// fail when the source changes, which is the one thing it is here to catch.
import assert from "node:assert";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = await build({
  entryPoints: [join(here, "src", "ytdlp.ts")],
  bundle: true, format: "esm", write: false, platform: "node",
});
const { ytdlpArgs, cleanUrl, outputTemplate } = await import(
  `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
);

const DIR = "D:\\Music";
const ui = ytdlpArgs({ url: "https://youtu.be/abc?si=track", dir: DIR, quality: "0", progress: true });
const agent = ytdlpArgs({ url: "https://youtu.be/abc?si=track", dir: DIR, quality: "0", progress: false });

// The regression that prompted this file.
for (const [name, args] of [["ui", ui], ["agent", agent]]) {
  assert.ok(args.includes("--windows-filenames"), `${name} lost --windows-filenames`);
  assert.ok(args.includes("--embed-thumbnail"), `${name} lost --embed-thumbnail`);
  assert.ok(args.includes("--no-overwrites"), `${name} lost --no-overwrites`);
}

// Audio only — a video file is something nothing else in a music library can play, sort or tag.
assert.ok(!ui.concat(agent).join(" ").includes("mp4"), "mp4 came back");
assert.ok(ui.includes("--extract-audio") && ui.includes("mp3"), "not asking for mp3");

// The ONLY difference between the two callers is the progress protocol.
const stripProgress = (a) =>
  a.filter((x, i) => !["--newline", "--progress-template", "--print"].includes(x)
    && !["--progress-template", "--print"].includes(a[i - 1]));
assert.deepEqual(stripProgress(ui), stripProgress(agent), "the two callers have drifted again");

// Only the UI parses proc-line, so only the UI asks for the stream that feeds it.
assert.ok(ui.includes("--newline") && ui.some((x) => x.startsWith("PROG\t")), "UI lost its progress template");
assert.ok(!agent.includes("--newline"), "agent asked for a progress stream it does not read");
assert.ok(agent.includes("after_move:%(filepath)s"), "agent cannot tell what landed");

// ?si= is tracking and goes; list= is what makes a URL a playlist and stays.
assert.equal(cleanUrl("https://youtu.be/abc?si=track"), "https://youtu.be/abc");
assert.equal(cleanUrl("https://youtube.com/watch?v=a&list=PL1&si=x"), "https://youtube.com/watch?v=a&list=PL1");
assert.equal(cleanUrl("https://youtu.be/abc"), "https://youtu.be/abc");

const playlist = ytdlpArgs({ url: "https://youtube.com/watch?v=a&list=PL1", dir: DIR, quality: "0" });
assert.ok(playlist.includes("--yes-playlist") && playlist.includes("--ignore-errors"));
assert.ok(ui.includes("--no-playlist"), "a single video should not pull the whole playlist");

// A playlist gets its own folder, numbered in order; a single file does not.
assert.ok(outputTemplate(DIR, true).includes("%(playlist_index)s"));
assert.equal(outputTemplate(DIR, false), `${DIR}\\%(title)s.%(ext)s`);

// Quality is passed through rather than interpreted.
assert.ok(ytdlpArgs({ url: "u", dir: DIR, quality: "192K" }).includes("192K"));

// ---- download failure messages -------------------------------------------------------------
// music-rust.ts rather than ytdlp.ts, and it needs the bridge shim stubbed: these are pure, but
// the module they live in imports Deck's own bindings at the top.
const fail = await build({
  entryPoints: [join(here, "src", "music-rust.ts")],
  bundle: true, format: "esm", write: false, platform: "node",
  plugins: [{
    name: "shim",
    setup(b) {
      b.onResolve({ filter: /shim\/bridge\.js$|@tauri-apps\/api\/event$/ },
        (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export const procStream = async () => ({});" +
                  "export const procKill = async () => {};" +
                  "export const fsList = async () => [];" +
                  "export const vaultResolve = async (s) => s;" +
                  "export const vaultRelativize = async (s) => s;" +
                  "export const vaultDataRead = async () => '';" +
                  "export const vaultDataWrite = async () => {};" +
                  "export const listen = async () => () => {};",
        loader: "js",
      }));
    },
  }],
});
const { exitReason, missingPython } = await import(
  `data:text/javascript;base64,${Buffer.from(fail.outputFiles[0].text).toString("base64")}`
);

// Exit 1 with nothing parsed off stdout is yt-dlp never having run. Saying "yt-dlp exited 1"
// there names the thing that did not start, and sends people to look at the URL.
assert.match(exitReason(1, false), /pip install -U yt-dlp/);
// Exit 1 AFTER a title is an ordinary download failure — yt-dlp ran and reported on the video,
// so telling someone to install it would be wrong.
assert.equal(exitReason(1, true), "yt-dlp exited 1");
// Any other code is its own problem; the code is more use than a guess at the cause.
assert.equal(exitReason(2, false), "yt-dlp exited 2");

// A spawn failure means `python` itself is missing — the one case where naming Python is right.
assert.match(missingPython("program not found"), /Python is not on PATH/);
assert.match(missingPython(new Error("os error 2")), /Python is not on PATH/);
// Anything else passes through: its own message beats a wrong guess.
assert.equal(missingPython("Access is denied"), "Access is denied");

// ---- which fix a missing tool gets --------------------------------------------------------
// tools.ts imports the bridge shim like music-rust.ts does, so it reuses the same stub plugin.
const tools = await build({
  entryPoints: [join(here, "src", "tools.ts")],
  bundle: true, format: "esm", write: false, platform: "node",
  plugins: [{
    name: "shim",
    setup(b) {
      b.onResolve({ filter: /shim\/bridge\.js$|@tauri-apps\/api\/event$/ },
        (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export const procStream = async () => ({});" +
                  "export const listen = async () => () => {};",
        loader: "js",
      }));
    },
  }],
});
const { fixFor } = await import(
  `data:text/javascript;base64,${Buffer.from(tools.outputFiles[0].text).toString("base64")}`
);

const state = (ok) => ({ ok, detail: "" });
const all = (py, yt, ff) => ({ python: state(py), ytdlp: state(yt), ffmpeg: state(ff) });

// Nothing to fix when it is already there — the row should read as an explanation, not a
// command someone has already run.
assert.equal(fixFor("ffmpeg", all(true, true, true)), "");
assert.equal(fixFor("python", all(true, true, true)), "");

// Each missing tool gets its own installer.
assert.match(fixFor("python", all(false, false, true)), /Python\.Python/);
assert.match(fixFor("ffmpeg", all(true, true, false)), /Gyan\.FFmpeg/);
assert.equal(fixFor("ytdlp", all(true, false, true)), "pip install -U yt-dlp");

// yt-dlp is a Python MODULE. With no Python there is nothing for pip to install into, so
// offering `pip install` would be a command that cannot work — the Python row is the fix.
assert.equal(fixFor("ytdlp", all(false, false, true)), "");

console.log("ytdlp: ok");
