# Steam Media Viewer

A desktop app for browsing Steam game recordings and screenshots. Games on the
left, that game's clips and screenshots on the right, with a built-in player.

## Requirements

Windows 11. Nothing else to install: ffmpeg ships with the app.

## Install

Download the installer from
[Releases](https://github.com/Riviawolf/Steam-Media-Viewer/releases) and run it.
It installs per user, so no admin prompt.

The build is unsigned, so SmartScreen will warn on first run. Choose More info,
then Run anyway.

## ffmpeg

Steam clips are not video files, so ffmpeg does the work of turning them into
something playable. A copy is bundled in the installer, under
`resourcesfmpeg` in the install folder, and is used in preference to any
ffmpeg already on `PATH`. Settings shows which one is in use and can be pointed
at a different build.

The bundled binary is the LGPL build from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds). Clips are
stream-copied rather than re-encoded, so nothing beyond LGPL is needed.

## Recordings

Steam does not save a clip as a video file. It saves a DASH stream: a
`session.mpd` manifest plus separate video and audio fragment streams
(`init-stream0.m4s`, `chunk-stream0-00001.m4s`, and so on). The first time a
clip is played it is stream-copied into a single MP4 and cached. Nothing is
re-encoded, so the wait is short even for 4K, and replays are instant.

Clips that span more than one capture session are joined in order. Clips with no
video segments are listed and marked unplayable.

Steam records in HEVC, which Windows 11 decodes through Media Foundation.

## Screenshots

Both layouts work: a flat folder of `appid_date_n.png` files, and Steam's own
per-game `<appid>/screenshots/` tree. Thumbnails are generated as needed, since
Steam's own are 200px wide and uncompressed originals can be tens of megabytes.

If the same screenshot turns up in more than one scanned folder, the duplicate
is dropped and the uncompressed original kept.

## Folders

Each of recordings and screenshots can follow Steam or use custom folders.
"Steam default" reads the paths out of the Steam config:

| | Read from |
|---|---|
| Recordings | `GameRecording/BackgroundRecordPath` in `localconfig.vdf` |
| Screenshots | `userdata/<id>/760/remote` |

Move a folder in Steam and the default follows it. **Refresh** re-reads the
config without restarting the app. Steam writes `localconfig.vdf` periodically
and on exit, so a change made seconds ago may not be on disk yet.

**Custom folder** takes a list, so media split across drives is scanned
together. Where more than one drive is in play, a drive filter appears and cards
are badged with the drive they came from.

If Steam is also set to keep uncompressed screenshots somewhere
(`InGameOverlayScreenshotSaveUncompressedPath`), Settings offers that folder as
a one-click addition.

## Views

**All Media** lists every clip and screenshot together, newest first, labelled
with the game it belongs to. Filters for drive, date and sort sit above the
list, along with a size slider for the previews.

Game names and artwork come from the local Steam install first
(`appinfo.vdf`, `appmanifest_*.acf`, `librarycache`), falling back to the Steam
store for anything missing. Lookups are cached and can be turned off in
Settings. Shift-clicking Refresh re-resolves them.

## Keyboard

| Key | |
|---|---|
| `/` | focus the game filter |
| `Esc` | close the player, viewer or settings |
| `←` `→` | previous / next |
| `Space` | play / pause |
| `J` `L` | back / forward 5s |
| `F` | fullscreen |

## Cache

Prepared MP4s and thumbnails live in `%APPDATA%\Steam Media Viewer\cache`. A
prepared clip is the same size as its source, so the cache has a size limit
(12 GB by default) and drops the least recently played. The limit and a clear
button are in Settings.

## Updates

Settings shows the installed version and a **Check for Updates** button, which
compares the latest release tag against the running version. A quiet check also
runs at launch. When an update exists the button opens the release page.

Releases are tagged `v<version>` to match `package.json`.

## Building

```bash
npm run dist
```

`npm run fetch-ffmpeg` runs first and downloads the ffmpeg binary into
`vendor/ffmpeg` if it is not already there. It is too large to keep in the
repository, so it is fetched at build time.

Produces `dist/Steam-Media-Viewer-Setup-<version>.exe`, a per-user installer
with shortcuts and an uninstaller. Uninstalling leaves
`%APPDATA%\Steam Media Viewer` in place so settings and cached clips survive a
reinstall.

`npm run pack` builds to `dist/win-unpacked` without an installer.

## Development

```bash
npm install
npm start          # run from source

npm run verify     # drives the app and checks it still works
npm run capture    # screenshots each screen into ./shots
npm run icon       # rebuild build/icon.ico from build/icon.svg
```

```
src/main/       main process: filesystem and ffmpeg
  appinfo.js    parser for Steam's binary appcache/appinfo.vdf
  vdf.js        parser for Steam's text KeyValues files
  steam.js      app id to name and artwork, cached on disk
  scanner.js    scanners for both media trees
  media.js      DASH to MP4 stream copy, thumbnails, cache eviction
  settings.js   settings.json
  updater.js    release check
  main.js       window, IPC, scan orchestration
  preload.js    renderer bridge
src/renderer/   UI
tools/          dev helpers
```

## License

MIT. See [LICENSE](LICENSE).

Steam is a trademark of Valve Corporation. This project is not affiliated with
or endorsed by Valve.
