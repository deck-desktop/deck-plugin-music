// The music plugin's own preferences, rendered by Deck in Settings → Plugins under "Music".
//
// This used to be a Group in Deck's own Settings, which meant Deck carried a preference for a
// feature it no longer contains. A plugin owning its settings is the point: Deck supplies the
// heading and the plugin renders whatever controls it has.
import { useEffect, useState } from "react";
import { Check, X, Loader2, RefreshCw, Copy } from "lucide-react";
import { configRead, configWrite, type Settings } from "../shim/bridge.js";
import { checkTools, fixFor, type ToolReport } from "./tools";

type Placement = Settings["playerPlacement"];

const OPTIONS: { value: Placement; label: string }[] = [
  { value: "fixed", label: "Fixed bar" },
  { value: "floating", label: "Floating" },
];

export default function MusicSettings() {
  const [placement, setPlacement] = useState<Placement>("fixed");
  // null while the first probe runs — three spawns, so it is not instant.
  const [tools, setTools] = useState<ToolReport | null>(null);
  const [checking, setChecking] = useState(false);

  const probe = () => {
    setChecking(true);
    checkTools().then(setTools).catch(() => setTools(null)).finally(() => setChecking(false));
  };
  // On open rather than behind a button: whether downloads will work is the reason someone
  // opens this panel, and a check they have to ask for is one they will not run.
  useEffect(probe, []);

  // Read from Deck's settings file rather than the plugin's own: PlayerBar already reads
  // playerPlacement from there, and moving the key would strand the value someone has set.
  useEffect(() => {
    configRead("settings/settings")
      .then((t) => { if (t.trim()) setPlacement(JSON.parse(t).playerPlacement ?? "fixed"); })
      .catch((e) => console.warn("[music] settings load failed", e));
  }, []);

  const save = async (next: Placement) => {
    setPlacement(next);
    // Read-modify-write, because this file is Deck's and holds everything else too. A plugin
    // writing its own object here would wipe the user's entire configuration.
    try {
      const t = await configRead("settings/settings");
      const all = t.trim() ? JSON.parse(t) : {};
      await configWrite("settings/settings", JSON.stringify({ ...all, playerPlacement: next }));
    } catch { /* a failed write leaves the old value; the toggle reverts on next read */ }
  };

  const rows: { key: keyof ToolReport; label: string; why: string }[] = [
    { key: "python", label: "Python", why: "yt-dlp runs as a Python module, so Python has to be there first." },
    { key: "ytdlp", label: "yt-dlp", why: "Does the downloading, and resolves a track to a stream for preview playback." },
    { key: "ffmpeg", label: "ffmpeg", why: "Converts to MP3, merges streams and embeds cover art. Downloads fail partway through without it." },
  ];
  const anyMissing = tools ? rows.some((r) => !tools[r.key].ok) : false;

  return (
    <div className="space-y-4">
      <div>
      <div className="mb-2 text-xs text-text-muted">
        How the mini player appears while something is playing.
      </div>
      <div className="flex overflow-hidden rounded-lg" style={{ background: "var(--bg-elev)" }}>
        {OPTIONS.map((o) => (
          <button key={o.value} onClick={() => void save(o.value)}
            className={"px-3 py-2 text-sm font-medium transition "
              + (placement === o.value ? "text-white" : "text-text-muted hover:text-text-secondary")}
            style={placement === o.value ? { background: "var(--accent-strong)" } : undefined}>
            {o.label}
          </button>
        ))}
      </div>
      </div>

      {/* What downloads need. Probed rather than asserted: a note that always says "install
          ffmpeg" is no use to someone who has it, and this is the panel they open when a
          download failed. Playback of files already in the library needs none of it. */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs text-text-muted">
            Downloading needs these. Playing what is already in your library does not.
          </span>
          <button onClick={probe} disabled={checking} title="Check again"
            className="flex shrink-0 items-center gap-1 rounded-md border border-subtle px-2 py-1 text-[11px] text-text-muted transition hover:text-text-primary disabled:opacity-50">
            <RefreshCw size={11} className={checking ? "animate-spin" : ""} /> Re-check
          </button>
        </div>
        <div className="space-y-1.5">
          {rows.map((r) => {
            const st = tools?.[r.key];
            const fix = tools ? fixFor(r.key, tools) : "";
            return (
              <div key={r.key} className="rounded-lg border border-subtle px-3 py-2"
                style={{ background: "var(--bg-elev)" }}>
                <div className="flex items-center gap-2">
                  {!st ? <Loader2 size={13} className="shrink-0 animate-spin text-text-muted" />
                    : st.ok ? <Check size={13} className="shrink-0" style={{ color: "#3fb950" }} />
                    : <X size={13} className="shrink-0 text-text-muted" />}
                  <span className="text-[13px] font-medium text-text-primary">{r.label}</span>
                  {st && (
                    <span className="truncate text-[11px]"
                      style={{ color: st.ok ? "#3fb950" : "var(--text-muted)" }}>{st.detail}</span>
                  )}
                </div>
                <div className="mt-0.5 pl-[21px] text-[11px] leading-relaxed text-text-muted">{r.why}</div>
                {/* Only while it is missing: a finished machine should read as an explanation,
                    not a wall of commands it no longer needs. */}
                {fix && <CopyLine text={fix} />}
              </div>
            );
          })}
        </div>
        {anyMissing && (
          <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
            Reopen your terminal (or Deck) after installing, so the new PATH is picked up, then
            press Re-check.
          </p>
        )}
      </div>
    </div>
  );
}

/** One command, monospaced, with a copy button. */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 ml-[21px] flex items-center gap-2 rounded-md border border-subtle px-2 py-1"
      style={{ background: "var(--bg-card)" }}>
      <code className="scroll-thin min-w-0 flex-1 overflow-x-auto whitespace-pre text-[11px] text-text-secondary">{text}</code>
      <button
        onClick={() => void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {})}
        title="Copy"
        className="shrink-0 rounded p-0.5 text-text-muted transition hover:text-text-primary">
        {copied ? <Check size={11} style={{ color: "#3fb950" }} /> : <Copy size={11} />}
      </button>
    </div>
  );
}
