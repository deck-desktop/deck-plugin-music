// Listen together (listen.ts), checked without the app or a network: three Decks on a fake team
// channel, each its own copy of the real module. What is checked: an invite and its Join, the
// host's track reaching a listener whole, that only invited members get in and only listeners get
// bytes, that a listener takes state and pieces from its host only, and leaving and ending.
//
//   node src/listen.check.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveObjectURL } from "node:buffer";
import { build } from "esbuild";

const members = { A: { id: "A", name: "Ann", pub: "" }, B: { id: "B", name: "Bo", pub: "" }, C: { id: "C", name: "Cy", pub: "" } };
const handlers = {};
const sent = [];
globalThis.__notes = { A: [], B: [], C: [] };
globalThis.__toasts = { A: [], B: [], C: [] };
globalThis.__files = {};
globalThis.__open = (me, h) => {
  handlers[me] = h;
  return {
    send: async (msg, to) => {
      for (const id of Object.keys(handlers)) {
        if (id === me || (to && id !== to)) continue;
        sent.push({ from: me, to: id, t: msg.t });
        const copy = JSON.parse(JSON.stringify(msg));
        setTimeout(() => handlers[id]?.message(copy, members[me]), 0);
      }
    },
    online: () => Object.values(members).filter((m) => m.id !== me),
    close: () => { delete handlers[me]; },
  };
};

const dir = mkdtempSync(join(tmpdir(), "deck-music-listen-"));
async function deck(me) {
  const out = join(dir, `listen-${me}.mjs`);
  await build({
    entryPoints: [join(import.meta.dirname, "listen.ts")], outfile: out, format: "esm", bundle: true, logLevel: "silent",
    plugins: [{ name: "stubs", setup(b) {
      b.onResolve({ filter: /^\.\.\/shim\// }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `
        export const teamChannel = (team, app, h) => globalThis.__open(${JSON.stringify(me)}, h);
        export const subscribeTeams = () => () => {};
        export const teamsView = () => [{ id: "t1", name: "Team", members: [] }];
        export const fsReadBytes = async (p) => { const b = globalThis.__files[p]; if (!b) throw new Error("no file"); return b; };
        export const notify = (n) => globalThis.__notes[${JSON.stringify(me)}].push(n);
        export const dismissNotification = () => {};
        export const toast = (t) => globalThis.__toasts[${JSON.stringify(me)}].push(t);` }));
    } }],
  });
  const L = await import(`file://${out}`);
  L.startListen();
  return L;
}
const A = await deck("A"), B = await deck("B"), C = await deck("C");
rmSync(dir, { recursive: true, force: true });
const settle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0)); };
const bytesOf = async (url) => new Uint8Array(await resolveObjectURL(url).arrayBuffer());

// A 1.3 MB track: ten pieces.
const song = new Uint8Array(1_300_000).map((_, i) => (i * 31) % 251);
globalThis.__files["C:/Music/song.mp3"] = song;
globalThis.__files["C:/Music/next.mp3"] = new Uint8Array(1000).fill(7);
let now = { track: { path: "C:/Music/song.mp3", title: "Song", artist: "Band" }, next: { path: "C:/Music/next.mp3", title: "Next" }, pos: 12, playing: true };
A.setHostSource(() => now);

// A invites Bo alone: Bo gets a notification with Join; Cy hears nothing.
A.invite("t1", "B");
await settle();
assert.equal(A.listenView().role, "host");
assert.equal(__notes.B.length, 1);
assert.match(__notes.B[0].title, /Ann invites you/);
assert.equal(__notes.C.length, 0);

// Join: Bo is a listener, the track arrives whole, then the next one; nothing is a path on Bo's Deck.
__notes.B[0].actions[0].run();
await settle();
assert.deepEqual(A.listenView().listeners.map((m) => m.id), ["B"]);
let v = B.listenView();
assert.equal(v.role, "listener");
assert.equal(v.host.id, "A");
assert.equal(v.track.title, "Song");
assert.equal(v.track.path, undefined);
assert.equal(v.playing, true);
assert.equal(v.pos, 12);
assert.ok(v.url, "the track arrived");
assert.deepEqual(await bytesOf(v.url), song);
assert.equal(sent.filter((s) => s.t === "chunk" && s.to === "B").length, 10 + 1, "ten pieces, then the one-piece next track");

// Cy was not invited: a join and a request for the track get nothing.
// (Cy has the session id here, as a peer who overheard it would.)
const sessionId = __notes.B[0].key.replace("invite-", "");
handlers.A.message({ t: "join", s: sessionId }, members.C);
await settle();
handlers.A.message({ t: "get", s: sessionId, id: B.listenView().track.id }, members.C);
await settle();
assert.equal(sent.filter((s) => s.to === "C").length, 0);
assert.equal(A.listenView().listeners.length, 1);

// Bo takes state only from its host: Cy's state is ignored, and so is a piece Bo never asked for.
const url = B.listenView().url;
handlers.B.message({ t: "state", s: sessionId, track: { id: "zz", title: "Evil" }, next: null, pos: 0, playing: false }, members.C);
handlers.B.message({ t: "chunk", s: sessionId, id: "zz", i: 0, n: 1, d: "AAAA" }, members.A);
await settle();
assert.equal(B.listenView().track.title, "Song");
assert.equal(B.listenView().url, url);

// The host moves on: Bo already has the next track, so it plays at once without asking again.
const asked = sent.filter((s) => s.t === "get").length;
now = { track: now.next, next: null, pos: 0, playing: true };
A.hostChanged();
await settle();
v = B.listenView();
assert.equal(v.track.title, "Next");
assert.ok(v.url);
assert.equal(sent.filter((s) => s.t === "get").length, asked);

// A whole-team invite reaches Cy, who joins too.
A.invite("t1");
await settle();
assert.equal(__notes.C.length, 1);
__notes.C[0].actions[0].run();
await settle();
assert.deepEqual(A.listenView().listeners.map((m) => m.id).sort(), ["B", "C"]);
assert.equal(C.listenView().track.title, "Next");

// Bo leaves; then Ann stops and Cy is told.
B.leave();
await settle();
assert.equal(B.listenView().role, "off");
assert.deepEqual(A.listenView().listeners.map((m) => m.id), ["C"]);
A.stopHosting();
await settle();
assert.equal(A.listenView().role, "off");
assert.equal(C.listenView().role, "off");
assert.match(__toasts.C[0], /Ann stopped/);

// The host going offline ends a listener's session too.
A.invite("t1", "B");
await settle();
__notes.B.at(-1).actions[0].run();
await settle();
assert.equal(B.listenView().role, "listener");
handlers.B.left(members.A);
assert.equal(B.listenView().role, "off");

for (const L of [A, B, C]) L.disposeListen();
console.log("listen: ok");
process.exit(0);
