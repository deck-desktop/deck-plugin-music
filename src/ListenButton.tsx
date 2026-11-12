// The player bar's "Listen together" button and its menu: invite a team or one member, see who is
// listening, stop; or, listening with someone, leave.
import { useState, useSyncExternalStore } from "react";
import { Users, UserPlus, LogOut, Square } from "lucide-react";
import { ContextMenu, type MenuEntry } from "../shim/ui.js";
import { subscribeTeams, teamsView, type TeamView } from "../shim/p2p.js";
import { invite, leave, listenView, stopHosting, subscribeListen } from "./listen";

function invites(t: TeamView, listening: Set<string>): MenuEntry[] {
  const others = t.members.filter((m) => !m.me && !listening.has(m.id));
  return [
    { label: `Invite everyone in ${t.name}`, icon: Users, disabled: !others.some((m) => m.online), onClick: () => invite(t.id) },
    ...others.map((m): MenuEntry => ({ label: `Invite ${m.name}`, icon: UserPlus, dot: m.online ? "ok" : "off", disabled: !m.online, onClick: () => invite(t.id, m.id) })),
  ];
}

export default function ListenButton() {
  const lv = useSyncExternalStore(subscribeListen, listenView);
  const teams = useSyncExternalStore(subscribeTeams, teamsView);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  let items: MenuEntry[];
  if (lv.role === "listener") {
    items = [{ label: `Listening with ${lv.host.name}`, disabled: true }, "sep", { label: "Leave", icon: LogOut, onClick: () => leave() }];
  } else if (lv.role === "host") {
    const team = teams.find((t) => t.id === lv.team);
    const names = lv.listeners.map((m) => m.name).join(", ");
    items = [
      { label: names ? `Listening: ${names}` : "No one has joined yet", disabled: true },
      ...(team ? ["sep" as const, ...invites(team, new Set(lv.listeners.map((m) => m.id)))] : []),
      "sep", { label: "Stop listening together", icon: Square, danger: true, onClick: stopHosting },
    ];
  } else if (!teams.length) {
    items = [{ label: "Start or join a team in Settings > Teams first", disabled: true }];
  } else if (teams.length === 1) {
    items = invites(teams[0], new Set());
  } else {
    items = teams.map((t): MenuEntry => ({ label: t.name, icon: Users, children: invites(t, new Set()) }));
  }

  const on = lv.role !== "off";
  const title = lv.role === "listener" ? `Listening with ${lv.host.name}` : lv.role === "host" ? "Listening together" : "Listen together";
  return (
    <>
      <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.top }); }} title={title} aria-label={title}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-white/5"
        style={{ color: on ? "var(--accent)" : "var(--text-muted)" }}>
        <Users size={15} />
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} up items={items} onClose={() => setMenu(null)} />}
    </>
  );
}
