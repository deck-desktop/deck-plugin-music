# Music for Deck

A music player for the folders you already keep music in, with YouTube downloads and song
suggestions. Open it from the **+** beside your tabs and choose **Music**; while something plays,
a player bar stays at the bottom of the window whatever tab you are on.

## Library and player

- Add any folder from the sidebar; its tracks show with the title, artist, album and cover art
  from their tags. Removing a folder takes it out of the library, not off disk.
- Heart a track to keep it in **Favorites**, or add it to a **playlist** from its menu. Play or
  shuffle a whole folder or playlist, and search within it.
- The bar has shuffle, repeat (all or one), seek and volume, and the Windows media keys and
  now-playing panel control it. The queue and volume are remembered. Settings > Plugins > Music
  sets the bar fixed along the bottom or floating.

## Downloads

- Paste links, one per line, and pick a quality (best, 192k or 128k) and a folder. Each becomes
  an MP3 with its tags and cover art; a playlist link fills a folder of its own, numbered in order.
- A queue downloads one at a time, with progress, cancel and retry, and keeps going while you use
  other tabs. A YouTube Mix or Radio link asks first, since one can hold hundreds of tracks.

## Discover

Write what you like under **Your taste** and press **Discover**: Claude Code searches the web and
suggests 5 to 20 songs you do not have yet, each with a reason, and keeps a short summary of your
taste from your library beside your own words. Preview a suggestion, then download the ones you
tick.

## Needs

- Downloads: Python, yt-dlp and ffmpeg on PATH. Settings > Plugins > Music checks for each and
  shows the command that installs what is missing. Playing your library needs none of them.
- Discover: Claude Code (the `claude` command) on PATH.

The library, playlists, download history, player state and taste profile are kept in
`data\music\` in Deck's config folder. Your music files stay where they are.

## For agents

`deck_download_music` in Deck's MCP server downloads a link, or a whole playlist, as MP3 into the
music download folder.
