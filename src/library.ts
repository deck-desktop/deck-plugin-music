// The Music plugin's own data, kept as its configs (data/music/ in Deck's config folder): the
// library, the download history, the discovery suggestions and the taste profile. These lived in
// Deck's bridge as music-only helpers; they are plain configRead / configWrite calls.
import { configRead, configWrite } from "../shim/bridge.js";

// A finished download, as recorded in the `downloads` config.
//
// `format` is optional because history written before downloads became mp3-only carries it.
// Nothing reads it now; dropping the field outright would make every old entry fail to parse.
export interface DownloadItem {
  id: string; url: string; title: string; quality: string; format?: string;
  filePath?: string; sizeBytes?: number; status: "done" | "failed"; at: number;
}
export const readDownloads = () => configRead("downloads");
export const writeDownloads = (json: string) => configWrite("downloads", json);

// The library: folders, favorites and playlists.
export interface MusicFolder { id: string; name: string; path: string; }
export interface MusicPlaylist { id: string; name: string; tracks: string[]; }
export interface MusicLibrary { folders: MusicFolder[]; favorites: string[]; playlists: MusicPlaylist[]; }
export const EMPTY_LIBRARY: MusicLibrary = { folders: [], favorites: [], playlists: [] };
export const readLibrary = async (): Promise<MusicLibrary> => {
  const t = await configRead("music-library");
  try { return t.trim() ? { ...EMPTY_LIBRARY, ...JSON.parse(t) } : EMPTY_LIBRARY; } catch { return EMPTY_LIBRARY; }
};
export const writeLibrary = (lib: MusicLibrary) => configWrite("music-library", JSON.stringify(lib));

// AI music discovery: the VPS writes suggestions, the plugin polls them.
export interface SongSuggestion { id: string; title: string; artist: string; why: string; }
export interface MusicSuggestions { generated_at: number; songs: SongSuggestion[]; }
export const readMusicSuggestions = async (): Promise<MusicSuggestions | null> => {
  const t = await configRead("music-suggestions");
  try { return t.trim() ? JSON.parse(t) : null; } catch { return null; }
};
// The taste profile is markdown, so it is named with its extension: a plain file, not a config.
export const readMusicTaste = () => configRead("music-taste.md");
export const writeMusicTaste = (text: string) => configWrite("music-taste.md", text);
