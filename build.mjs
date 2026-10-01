// Build the music plugin.
//
//   node plugins/music/build.mjs
//
// Everything happens in the shared builder; see plugins/build-plugin.mjs for what the shims do
// and why React has to come from Deck rather than from here.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "../build-plugin.mjs";

await buildPlugin(dirname(fileURLToPath(import.meta.url)));
