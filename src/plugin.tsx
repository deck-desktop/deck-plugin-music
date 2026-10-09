// Deck's music feature, as a plugin.
//
// Deck ships no music module: this plugin is the library browser, the player, the download queue
// and the bar along the bottom. Deck contributes only primitives that know nothing about music —
// vault_resolve/vault_relativize for paths the phone can read, proc_stream for running yt-dlp,
// fs_list/fs_open/dirs_download, audio_tags for ID3, and media_session for the Windows media keys.
//
// THREE EXPORTS, WHICH IS WHY MUSIC NEEDED MORE THAN THE SORTER DID
//
// `default` is the sidebar module — the library, playlists, downloads and Discover.
//
// `Provider` wraps the whole app. A module unmounts the moment you navigate away, so playback
// state and the <audio> element cannot live there or the music would stop when you opened the
// editor. This is Deck's own PlayerProvider, moved here unchanged.
//
// `Bar` renders in the strip below the active module, where the player bar has always been. A
// Provider cannot reach that spot — it wraps the tree from outside and the bar is inside it.
//
// WHAT STAYS IN DECK, AND WHY THAT IS NOT A CHEAT
// audio_tags and media_session are Rust because they are native-library work (lofty, souvlaki)
// that no amount of JavaScript replaces. They are named for what they do rather than for music,
// and a video-player plugin would use both. That is the test the primitives had to pass: not
// "does music use it", but "could someone else".
//
// PHONE COMPATIBILITY
// music-library, favorites and playlists keep the exact config keys and the vault-relative path
// format they always had. The phone app reads those directly and is a separate codebase; this
// port changes who writes them, not what they are.
import Music from "./Music";
import { PlayerProvider } from "./player";
import PlayerBar from "./PlayerBar";
import MusicSettings from "./settings";

export default Music;
export const Provider = PlayerProvider;
export const Bar = PlayerBar;

// Rendered by Deck in Settings -> Plugins, under this plugin name.
export const Settings = MusicSettings;
/** Called by Deck before a reload re-imports this plugin, so the old copy stops listening. */
export { disposeDownloads as dispose } from "./downloads";
