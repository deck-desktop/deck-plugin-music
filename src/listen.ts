// Listen together: one Deck plays, members of one of its teams hear the same track at the same
// moment. It runs over a team channel ("listen"), opened on every team at plugin load, so an invite
// reaches this Deck whether or not the Music tab is open.
//
// The host is the only one who controls playback. Its files are not on the others' Decks, so a
// listener asks for each track (and the one after it) and the host sends it in pieces, which the
// listener plays from memory through a blob: address. Nothing a peer sends is ever used as a path.
//
// Every message is checked: who it may come from (the host, or a member the host invited) and what
// it may hold (lengths, piece counts, a size cap).
import { teamChannel, subscribeTeams, teamsView, type TeamChannel, type Member } from "../shim/p2p.js";
import { fsReadBytes } from "../shim/bridge.js";
import { notify, dismissNotification, toast } from "../shim/ui.js";

/**
 * A piece of a track before base64. Small, so a state sent while a track is on its way waits behind
 * one piece, not a big one; a team message must anyway stay under 2 MB after base64 and encryption.
 */
const CHUNK = 128 * 1024;
/** 80 MB: a bigger track is not shared. */
const MAX_PIECES = 640;
/** The host says where it is this often, so listeners keep in step. */
const BEAT = 5000;
const SOURCE = "Music";

/** A track as listeners see it: never its path. `stream`: a Discover preview, which is not shared. */
export type Shared = { id: string; title: string; artist?: string; stream?: boolean };
export type HostTrack = { path: string; title: string; artist?: string; streamUrl?: string };
/** What the host's player is doing right now, read at the moment a state goes out. */
export type HostNow = { track: HostTrack | null; next: HostTrack | null; pos: number; playing: boolean };
export type ListenView =
  | { role: "off" }
  | { role: "host"; team: string; listeners: Member[] }
  | { role: "listener"; team: string; host: Member; track: Shared | null; url: string | null; playing: boolean; pos: number; at: number };

type Msg =
  | { t: "invite" | "join" | "leave" | "end"; s: string }
  | { t: "state"; s: string; track: Shared | null; next: Shared | null; pos: number; playing: boolean }
  | { t: "get"; s: string; id: string }
  | { t: "chunk"; s: string; id: string; i: number; n: number; d: string };

let view: ListenView = { role: "off" };
const subs = new Set<() => void>();
const set = (v: ListenView) => { view = v; subs.forEach((f) => f()); };
export const listenView = () => view;
export const subscribeListen = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

const chans = new Map<string, TeamChannel<Msg>>();
const ch = () => (view.role === "off" ? undefined : chans.get(view.team));
let unTeams: (() => void) | null = null;
let stopped = true;
/** The session: made by the host at its first invite, carried by every message. */
let sid = "";

// ---- the host -----------------------------------------------------------------------------------

let invitedAll = false;
const invited = new Set<string>();
const listeners = new Map<string, Member>();
let source: (() => HostNow) | null = null;
/** Shared id to path, for the current and next track only: nothing else is ever sent. */
let files = new Map<string, string>();
const bytes = new Map<string, Promise<Uint8Array>>();
let beat: ReturnType<typeof setInterval> | null = null;

/** A short id for a track, the same each time, so a listener keeps what it already has. */
function idOf(t: HostTrack) {
  let h = 0x811c9dc5;
  for (const c of t.path + "\n" + (t.streamUrl ?? "")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(36);
}
const shared = (t: HostTrack | null): Shared | null =>
  t && { id: idOf(t), title: (t.title || t.path.split(/[\\/]/).pop() || "").slice(0, 200), artist: t.artist?.slice(0, 200), ...(t.streamUrl ? { stream: true } : {}) };

/** The player tells the store how to read where it is. */
export function setHostSource(f: (() => HostNow) | null) { source = f; }

function stateMsg(): Msg | null {
  if (!source) return null;
  const now = source();
  const track = shared(now.track), next = shared(now.next);
  files = new Map();
  if (track && !track.stream) files.set(track.id, now.track!.path);
  if (next && !next.stream) files.set(next.id, now.next!.path);
  for (const id of [...bytes.keys()]) if (!files.has(id)) bytes.delete(id);
  return { t: "state", s: sid, track, next, pos: now.pos, playing: now.playing };
}

/** Something changed in the host's player (a track, play or pause, a seek): the listeners hear it now. */
export function hostChanged() {
  if (view.role !== "host" || !listeners.size) return;
  const m = stateMsg();
  if (m) for (const id of listeners.keys()) void ch()?.send(m, id);
}

const toB64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

async function serve(id: string, to: string) {
  const path = files.get(id);
  if (!path) return;
  let p = bytes.get(id);
  if (!p) bytes.set(id, p = fsReadBytes(path));
  const b = await p.catch((e: unknown) => { console.warn("[music] reading a track to share failed", e); bytes.delete(id); return null; });
  // ponytail: a track over 80 MB is not sent and its listeners hear nothing; say so if it happens.
  const n = b ? Math.ceil(b.length / CHUNK) : 0;
  if (!b || !n || n > MAX_PIECES) return;
  const s = sid;
  for (let i = 0; i < n; i++) {
    // Stopped, the listener gone, or the host moved on past this track and the next.
    if (view.role !== "host" || sid !== s || !listeners.has(to) || !files.has(id)) return;
    await ch()?.send({ t: "chunk", s, id, i, n, d: toB64(b.subarray(i * CHUNK, (i + 1) * CHUNK)) }, to);
  }
}

/** Invite one member, or (no member) everyone in the team: the first invite starts the session. */
export function invite(team: string, member?: string) {
  if (view.role === "listener") leave();
  if (view.role === "host" && view.team !== team) return;
  if (view.role === "off") {
    sid = crypto.randomUUID();
    invitedAll = false; invited.clear(); listeners.clear();
    set({ role: "host", team, listeners: [] });
    beat = setInterval(hostChanged, BEAT);
  }
  if (member) invited.add(member); else invitedAll = true;
  void chans.get(team)?.send({ t: "invite", s: sid }, member);
}

export function stopHosting() {
  if (view.role !== "host") return;
  for (const id of listeners.keys()) void ch()?.send({ t: "end", s: sid }, id);
  if (beat) clearInterval(beat);
  beat = null; listeners.clear(); invited.clear(); bytes.clear(); files = new Map(); sid = "";
  set({ role: "off" });
}

// ---- a listener ---------------------------------------------------------------------------------

/** Invites heard, by session, until joined or the plugin stops. */
const pending = new Map<string, { team: string; host: Member }>();
const blobs = new Map<string, string>();
/** Tracks being received; an entry with n = 0 has been asked for and nothing has come yet. */
const parts = new Map<string, { n: number; got: Uint8Array[]; count: number }>();
let want: { track: Shared | null; next: Shared | null } = { track: null, next: null };

export function join(s: string) {
  const inv = pending.get(s);
  if (!inv) return;
  pending.delete(s);
  dismissNotification(SOURCE, `invite-${s}`);
  if (view.role === "host") stopHosting(); else leave();
  sid = s;
  want = { track: null, next: null };
  set({ role: "listener", team: inv.team, host: inv.host, track: null, url: null, playing: false, pos: 0, at: Date.now() });
  void chans.get(inv.team)?.send({ t: "join", s }, inv.host.id);
}

/** Stop listening. `told`: the host already ended it, so it is not told again. */
export function leave(told = false) {
  if (view.role !== "listener") return;
  if (!told) void ch()?.send({ t: "leave", s: sid }, view.host.id);
  for (const u of blobs.values()) URL.revokeObjectURL(u);
  blobs.clear(); parts.clear(); sid = "";
  set({ role: "off" });
}

/** Ask the host for the track playing, then for the one after it, one at a time. */
function fetchNext() {
  if (view.role !== "listener") return;
  for (const t of [want.track, want.next]) {
    if (!t || t.stream || blobs.has(t.id)) continue;
    if (parts.has(t.id)) return;
    parts.set(t.id, { n: 0, got: [], count: 0 });
    void ch()?.send({ t: "get", s: sid, id: t.id }, view.host.id);
    return;
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : undefined);
function cleanShared(v: unknown): Shared | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 16), title = str(o.title, 200);
  if (!id || title === undefined || (o.artist !== undefined && str(o.artist, 200) === undefined)) return undefined;
  return { id, title, ...(o.artist ? { artist: o.artist as string } : {}), ...(o.stream === true ? { stream: true } : {}) };
}

function onState(m: Extract<Msg, { t: "state" }>) {
  if (view.role !== "listener") return;
  const track = cleanShared(m.track), next = cleanShared(m.next);
  if (track === undefined || next === undefined || typeof m.pos !== "number" || !isFinite(m.pos) || m.pos < 0 || typeof m.playing !== "boolean") return;
  want = { track, next };
  const keep = new Set([track?.id, next?.id]);
  for (const [id, u] of blobs) if (!keep.has(id)) { URL.revokeObjectURL(u); blobs.delete(id); }
  for (const id of [...parts.keys()]) if (!keep.has(id)) parts.delete(id);
  set({ ...view, track, url: (track && blobs.get(track.id)) ?? null, playing: m.playing, pos: m.pos, at: Date.now() });
  fetchNext();
}

function onChunk(m: Extract<Msg, { t: "chunk" }>) {
  if (view.role !== "listener") return;
  const p = parts.get(m.id);
  const { i, n } = m;
  if (!p || !Number.isInteger(n) || n < 1 || n > MAX_PIECES || !Number.isInteger(i) || i < 0 || i >= n || (p.n && p.n !== n)) return;
  if (typeof m.d !== "string" || m.d.length > Math.ceil(CHUNK / 3) * 4) return;
  p.n = n;
  if (!p.got[i]) {
    try { p.got[i] = Uint8Array.from(atob(m.d), (c) => c.charCodeAt(0)); } catch { return; }
    p.count++;
  }
  if (p.count < n) return;
  parts.delete(m.id);
  const url = URL.createObjectURL(new Blob(p.got as BlobPart[]));
  blobs.set(m.id, url);
  if (view.track?.id === m.id) set({ ...view, url });
  fetchNext();
}

// ---- the channel --------------------------------------------------------------------------------

function onMsg(team: string, m: Msg, from: Member) {
  if (!m || typeof m !== "object" || typeof m.s !== "string" || m.s.length > 64) return;
  const fromHost = view.role === "listener" && view.team === team && from.id === view.host.id && m.s === sid;
  const mine = view.role === "host" && view.team === team && m.s === sid;
  switch (m.t) {
    case "invite": {
      if (view.role === "listener" && m.s === sid) return;
      if (pending.size >= 20) pending.delete(pending.keys().next().value!);
      pending.set(m.s, { team, host: from });
      const s = m.s;
      notify({ source: SOURCE, kind: "attention", key: `invite-${s}`, sticky: true,
        title: `${from.name} invites you to listen together`, body: "You hear what they play, as they play it.",
        actions: [{ label: "Join", primary: true, run: () => join(s) }] });
      return;
    }
    case "join":
      if (!mine || !(invitedAll || invited.has(from.id))) return;
      listeners.set(from.id, from);
      set({ role: "host", team, listeners: [...listeners.values()] });
      { const st = stateMsg(); if (st) void ch()?.send(st, from.id); }
      return;
    case "leave":
      if (mine && listeners.delete(from.id)) set({ role: "host", team, listeners: [...listeners.values()] });
      return;
    case "get":
      if (mine && listeners.has(from.id) && typeof m.id === "string") void serve(m.id, from.id);
      return;
    case "end":
      if (fromHost) { toast(`${from.name} stopped listening together`); leave(true); }
      return;
    case "state": if (fromHost) onState(m); return;
    case "chunk": if (fromHost) onChunk(m); return;
  }
}

function onJoined(team: string, m: Member) {
  // A member who comes online after a whole-team invite is invited too.
  if (view.role === "host" && view.team === team && invitedAll && !listeners.has(m.id)) void chans.get(team)?.send({ t: "invite", s: sid }, m.id);
}

function onLeft(team: string, m: Member) {
  if (view.role === "host" && view.team === team && listeners.delete(m.id)) set({ role: "host", team, listeners: [...listeners.values()] });
  if (view.role === "listener" && view.team === team && view.host.id === m.id) { toast(`${m.name} went offline`); leave(true); }
}

/** A channel on every team this Deck is in; leaving a team closes its channel and its session. */
function channels() {
  if (stopped) return;
  const teams = new Set(teamsView().map((t) => t.id));
  for (const [team, c] of chans) {
    if (teams.has(team)) continue;
    if (view.role !== "off" && view.team === team) { if (view.role === "host") stopHosting(); else leave(true); }
    c.close(); chans.delete(team);
  }
  for (const team of teams) {
    if (!chans.has(team)) chans.set(team, teamChannel<Msg>(team, "listen", {
      message: (m, from) => onMsg(team, m, from), joined: (m) => onJoined(team, m), left: (m) => onLeft(team, m),
    }));
  }
}

export function startListen() {
  stopped = false;
  unTeams = subscribeTeams(channels);
  channels();
}

export function disposeListen() {
  stopHosting(); leave();
  stopped = true;
  unTeams?.(); unTeams = null;
  for (const c of chans.values()) c.close();
  chans.clear(); pending.clear();
}
