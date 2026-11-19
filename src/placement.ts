// Where the player shows while something plays: a bar along the bottom ("fixed"), a card you can drag
// ("floating"), or a readout in Deck's footer that opens the player as its menu ("footer").
//
// Kept in Deck's settings file, under playerPlacement, where it has always been (the music feature
// was Deck's own once): moving the key would strand the value someone has set. The type is the
// plugin's, since "footer" is a choice only this plugin knows.
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { configRead, configWrite } from "../shim/bridge.js";

export type Placement = "fixed" | "floating" | "footer";

const parse = (t: string): Placement => {
  const v = t.trim() ? JSON.parse(t).playerPlacement : undefined;
  return v === "floating" || v === "footer" ? v : "fixed";
};

/** The placement, read again whenever Settings writes it, so a change shows at once. */
export function usePlacement(): Placement {
  const [placement, setPlacement] = useState<Placement>("fixed");
  useEffect(() => {
    const load = () => configRead("settings/settings").then((t) => setPlacement(parse(t)))
      .catch((e) => console.warn("[music] settings load failed", e));
    load();
    const un = listen<string[]>("config-changed", (e) => { if (e.payload.includes("settings/settings")) load(); });
    return () => { void un.then((f) => f()); };
  }, []);
  return placement;
}

/** Saves the placement. Read-modify-write: the file is Deck's and holds every other setting too. */
export async function savePlacement(next: Placement) {
  const t = await configRead("settings/settings");
  const all = t.trim() ? JSON.parse(t) : {};
  await configWrite("settings/settings", JSON.stringify({ ...all, playerPlacement: next }));
}

export const readPlacement = () => configRead("settings/settings").then(parse);
