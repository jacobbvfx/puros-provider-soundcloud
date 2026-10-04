/**
 * SoundCloud web API (api-v2) protocol facts. Sources, recorded for review:
 * - yt-dlp 2026.08.19 (Unlicense), `yt_dlp/extractor/soundcloud.py`: client_id
 *   scraping from the web app's asset scripts, `Authorization: OAuth <token>`,
 *   transcoding presets/protocols, `track_authorization`, the original
 *   download endpoint, DRM protocols (`ctr-`/`cbc-encrypted-hls`) and the
 *   broken `abr_*` preset.
 * - scdl 061c43660ee54aa0304b8d137c5f1168b1fb53b4 (GPL-2.0): `oauth_token`
 *   cookie as the auth token, original-file preference.
 * - soundcloud.py c5745adcf17da292cd33a28da45feffb503e115a (MIT): endpoint list
 *   (`/me`, `/users/{id}/likes`, `/playlists_without_albums`, `/albums`,
 *   `/followings`, `/toptracks`, `/relatedartists`, `/tracks?ids=`).
 * - Live signed-out api-v2 responses checked on 2026-10-02. Only protocol facts
 *   are used; no code from these projects is copied.
 */

export const WEB_ORIGIN = 'https://soundcloud.com'
export const API_BASE_URL = 'https://api-v2.soundcloud.com/'
export const API_HOST = 'api-v2.soundcloud.com'

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** The web app's asset scripts, one of which embeds `client_id:"<32 chars>"`. */
export const ASSET_SCRIPT_PATTERN = /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g
export const CLIENT_ID_PATTERN = /client_id\s*:\s*"([0-9a-zA-Z]{32})"/

/** `linked_partitioning` page size; SoundCloud documents 200 as the maximum. */
export const MAX_PAGE_SIZE = 200
/** `GET /tracks?ids=` accepts at most this many IDs per request. */
export const TRACK_BATCH_SIZE = 50

export const PROVIDER_LABEL = 'SoundCloud'
