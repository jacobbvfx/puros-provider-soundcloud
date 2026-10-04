# SoundCloud provider for Puros

This repository is the SoundCloud provider plugin for Puros, a macOS music player. It integrates through the public provider API v1 only ([Provider SDK](https://github.com/purosapp/puros-provider-sdk)) and contains no Puros code. Puros keeps the library database, queue, decoding, DSP, output and every view; this provider talks to SoundCloud's web API (api-v2), maps the catalog, enumerates the library and prepares audio files.

## Install

1. Download `puros-provider-soundcloud-<version>.zip` from [Releases](../../releases).
2. In Puros open **Settings → Accounts → Install provider…** and choose the ZIP.
3. Review the permissions and warnings, then install. Later versions use **Update from file…** on the installed provider.

## Sources used

| Source | Version | Used for |
| --- | --- | --- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense), `yt_dlp/extractor/soundcloud.py` | `2026.08.19` | Protocol facts: `client_id` scraping from the web app's asset scripts, `Authorization: OAuth <token>`, transcodings and `track_authorization`, the original-download endpoint, DRM protocols, the broken `abr_*` preset, the ~600 requests / 10 min rate limit |
| [scdl](https://github.com/scdl-org/scdl) (GPL-2.0) | `061c43660ee54aa0304b8d137c5f1168b1fb53b4` (2026-08-20) | The `oauth_token` cookie as the auth token; original files preferred when allowed |
| [soundcloud.py](https://github.com/7x11x13/soundcloud.py) (MIT) | `c5745adcf17da292cd33a28da45feffb503e115a` | Endpoint list: `/me`, `/users/{id}/likes`, `/playlists_without_albums`, `/albums`, `/followings`, `/toptracks`, `/relatedartists`, `/tracks?ids=` |
| [BetterSoundCloud](https://github.com/AlirezaKJ/BetterSoundCloud) (GPL-3.0) | `fb3bfdd0fc3ab9f334a88675cf3e50ad718f2136` | Embedded-Chromium sign-in needs a Chrome user agent; cookie-based sessions |
| Live api-v2 responses | checked 2026-10-02, signed out | Response shapes (test fixtures in `src/fixtures.ts` follow them; public catalog data only) |

No code from these projects is copied; the provider is an independent TypeScript implementation that uses only Node's `fetch`. Plain `fetch` reached every endpoint used here on 2026-10-02 (soundcloud.py impersonates Chrome's TLS fingerprint with curl_cffi, and yt-dlp notes DataDome blocks old fingerprints on paged user endpoints; if that ever applies to Node, paged library requests will fail with HTTP 403 and the sync stops without a partial import).

## Connecting

Public SoundCloud works **without an account**: search, artists, albums, playlists, home and playback of every track SoundCloud streams to signed-out listeners. Sign in for your library, private sets and SoundCloud Go+ streams.

- **Sign in with SoundCloud** opens soundcloud.com/signin in a private, in-memory browser window (host feature `auth.browser-session`, Chrome user agent). Once soundcloud.com sets the `oauth_token` cookie, the window closes and the host returns only that value; the partition is wiped. The host denies pop-ups, so **Google, Apple and Facebook sign-in do not work in this window** — use email and password, or the token form.
- **Connect with a token** takes the `oauth_token` cookie value from a signed-in soundcloud.com tab (DevTools → Application/Storage → Cookies). `oauth_token=…`, `OAuth …` and quoted values are accepted.

Either way Puros calls `GET /me` with the token and saves it (through `host.secrets`, encrypted by the host) only when SoundCloud answers with an account; the status then shows "Connected as …". A refused token leaves the previous session untouched. The token is never logged, returned or put in events. When api-v2 refuses the saved token (after the client ID has been renewed once, see below), the status turns to "Sign-in expired", the token is no longer sent, and public playback continues as a guest. **Disconnect** deletes the secret.

**Client ID.** Every api-v2 request carries the web app's public `client_id`, scraped from soundcloud.com's asset scripts and kept in `host.storage`. It changes with SoundCloud web releases: on HTTP 401/403 the provider scrapes a new one (at most once a minute) and repeats the request once before believing the answer.

## Catalog, library and home

- Source IDs are SoundCloud's numeric IDs unchanged: tracks, users (artists), playlists and albums (albums are playlists with an album `set_type`); mixes and stations are `soundcloud:system-playlists:…` URNs.
- The credited artist is the uploader (SoundCloud's own identity). Publisher metadata, when the uploader supplied it, gives the ISRC, UPC, the label's album title, and performer/writer credits for the details panel; nothing is invented.
- Search: tracks, users, albums and playlists, each with its own `next_href` continuation.
- Artist pages: profile and bio, top tracks, albums, playlists, related artists.
- Sets embed only their first tracks; the rest ("stubs") are fetched 50 at a time through `/tracks?ids=`, keeping the set's order.
- Home: `mixed-selections` (curated playlists, "Trending by genre", personalized mixes when signed in); each item opens as a collection.
- Library (`host-mirror`): liked tracks, liked and own playlists and albums with every track, followed artists. Any failed page fails the whole sync, so a partial snapshot is never reported complete. A liked set that its owner deleted or made private (HTTP 404/403) is left out.

## Playback

1. `GET /tracks/{id}` (with the token when signed in) lists the transcodings. Previews (`snipped`, policy `SNIP`) are never played as the track: if nothing else exists the error says the track needs SoundCloud Go+. DRM-only tracks (`ctr-`/`cbc-encrypted-hls`) and geo-blocked tracks fail with typed errors.
2. The best playable stream is chosen: AAC at 160 kb/s and up (Go+ `hq` AAC 256 kb/s first), then MP3 128 kb/s (progressive before HLS), then AAC 96 kb/s. The transcoding URL plus `track_authorization` returns a signed media address.
3. Progressive MP3 is downloaded as one file (length checked against `Content-Length`). HLS is downloaded segment by segment, eight requests in flight, written strictly in order; playlists with encryption keys, byte ranges, discontinuities or no end marker are refused. MP3 segments concatenate into the MP3 itself; AAC arrives as fragmented MP4 (init + `.m4s`) and is stream-copied by the pinned LGPL ffmpeg (`-c:a copy`) into a plain M4A, where AudioToolbox honours AAC's encoder delay and end trim.
4. Every file is decoded end to end by the `probe` helper and its length compared with SoundCloud's (2 s or 2 %); only then is it registered with `host.cache` and returned `complete`. A wrong length, an expired media address (HTTP 403) or a dropped connection is retried with a fresh address, up to three attempts.
5. Formats reported: `AAC` or `MP3` at the stream's rate, `bitDepth` 0, the declared bitrate (kb/s), lossy, never Hi-Res. The player labels both 16-bit (display only); the stored `bitDepth` stays 0 so output negotiation never treats the decode as 16-bit PCM. Nothing is re-encoded, resampled or normalized.

**Original uploads (opt-in).** Settings → Audio source → "Original upload when the artist allows downloads". When signed in and the track is `downloadable` with downloads left, `GET /tracks/{id}/download` gives the artist's file. Its container is identified from its first bytes (FLAC, WAV, AIFF, M4A, MP3; ID3 tags are skipped) and, if core plays it directly, it is verified like a stream (5 s tolerance) and reported with the format core inspects — often lossless. Anything else (Ogg, unknown container, no downloads left, a refusal) falls back to the stream. Each original fetch counts as a download on the artist's track.

Downloads are single-flight per track, at most two at a time, playback ahead of prefetch, cancellable per session, with progress events. There is no progressive (play-while-downloading) mode yet: a typical track is ready in about a second; a 2-hour mix (708 AAC segments, 143 MB) took about 8 s on a fast connection, of which ~5 s is the full decode check.

## Build and test

Requirements:

- macOS with the Xcode command line tools
- Node.js 22.12 or newer
- cmake (`brew install cmake`), used once to build the pinned ffmpeg

```sh
npm install
npm run typecheck
npm test                 # offline unit tests
npm run package          # runs helper/build.sh, writes release/puros-provider-soundcloud-<version>.zip
```

`npm run build` runs only the helper build. `helper/build.sh` installs the SDK's pinned, self-contained LGPL ffmpeg (`puros-provider ffmpeg`) and self-checks it in the clean environment helpers get at runtime.

## Releases

GitHub Actions builds every push and pull request on macOS. Every push to `main` publishes a release `v<version>-build.<run>` with the compiled `puros-provider-soundcloud-<version>.zip` and its `.sha256`, so the newest build is always on the [latest release](../../releases/latest). Pushing a tag `v<version>` that matches `version` in `provider.manifest.json` publishes the versioned release `v<version>`. When the repository secret `PUROS_PROVIDER_SIGNING_KEY` holds an Ed25519 publisher key (`npx puros-provider keygen --out=<path outside the repo>`), released packages are signed with it; Puros pins that key on first install.

## Not yet verified

Only signed-out flows were tested against live SoundCloud. With an account, still to check by hand: the sign-in window (email/password), the token form, `/me`, the library sync (likes, own private sets, followings), Go+ `hq` streams (preset name and bitrate are taken from yt-dlp, not observed), and original downloads. Library parsing is tested on fixtures shaped like the public responses of the same endpoints.

## Licenses

`helper/dist`: ffmpeg, LGPL-2.1-or-later (`FFMPEG-COPYING.LGPLv2.1`, `FFMPEG-BUILD-INFO.json`), with libsoxr (`SOXR-COPYING.LGPL`). The provider's own code is MIT licensed ([LICENSE](LICENSE)). Using SoundCloud this way is subject to SoundCloud's terms of use; review them before distributing the provider.
