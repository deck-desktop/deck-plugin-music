# Music (Deck plugin)

Deck's music feature, living outside the binary: library, playlists, the download queue,
Discover, the player, and the bar along the bottom.

## Build

```sh
node plugins/music/build.mjs
```

See [../README.md](../README.md) for how the build and the shims work.

## Install

Copy `plugin.json`, `plugin.js` and `mcp.js` into `%APPDATA%\Deck\plugins\music\` (`Deck-Dev` for a debug
build) and restart Deck.

## What it exports

| Export | Where it renders |
|---|---|
| `default` | the sidebar module |
| `Provider` | wraps the whole app, so playback survives navigating away |
| `Bar` | the strip below the active module |

## What Deck provides

Nothing music-specific except two native pieces that no amount of JavaScript replaces:

- `audio_tags` — ID3 tags and cover art (lofty)
- `media_session` — the Windows media keys and the OS now-playing panel (souvlaki)

Everything else is generic: `vault_resolve`/`vault_relativize` for paths the phone can read,
`proc_stream` for running yt-dlp, `fs_list`, `fs_open`, `dirs_download`, and config read/write.

## Phone compatibility

`music-library`, `favorites` and `playlists` keep the config keys and the vault-relative path
format they have always had. The phone app reads those directly, so this port changes who writes
them, not what they are.
