# Universal Tracker — verified page recording

Register your reachable website and include the widget on your page. The widget records the whole page automatically, then saves its session and generates an MP4 when a page action navigates/reloads or the visitor submits a normal form. **No form and no form attributes are required; no host backend endpoint is required.**

## Signup and integration

Signup checks the registered website with an HTTP GET to its root. HTTP 200 completes signup and creates an account/login session. Up to three same-origin redirects (such as a login redirect) are followed. Cross-origin redirects, failed connections and non-200 final responses reject signup without creating an account. This is an availability check, not proof of ownership.

After signup, open **Profile & integration** and copy the script tag. No API key, host .env variables, host token endpoint or CSRF meta tag is needed by the tracker.

Local development domains require the tracker setting LOCAL_VERIFICATION_ORIGINS=http://local.3duiq.com and a restart. This exact-origin override is ignored in production; private-network checks remain blocked by default.

Previously checked accounts continue working without keys. Legacy unchecked accounts remain blocked for tracking; they are not automatically trusted. Old API-key database columns are retained for compatibility but are no longer read for authorization. Old host token endpoints and PAGE_TRACKER_* host environment variables may be removed.

Recording initialization requires a registered, checked Origin. Uploads retain signed, account-bound session tokens and tenant isolation. Origin headers can be forged by non-browser clients; this flow does not authenticate the sending host with a secret.

## Install in an existing project

Keep this Node/MySQL tracker running as a separate service. The website being recorded can use PHP, Laravel, WordPress, React, Vue, plain JavaScript, Java, .NET, or another stack: recording runs in the browser and does not depend on the site's backend language.

Add this to the shared layout/template or any rendered view of every page you want recorded. It can be in the head, body, or footer:

```html
<script src="https://tracker.yourdomain.com/tracker.js" defer></script>
```

Use your tracker service's real HTTPS URL. For local development:

```html
<script src="http://localhost:3000/tracker.js" defer></script>
```

Create an account at `/login.html?signup=1` with your name, email, password (12–128 characters), and company domain. Enter the **exact origin** of the project being recorded, such as `http://myproject.local` or `http://localhost:5173`. A domain without a scheme defaults to HTTPS. No page path is allowed.

Allowed origins are looked up in the MySQL `accounts` table on each tracking request. `ALLOWED_ORIGINS` is no longer read. One origin belongs to one account; duplicate emails and origins are rejected. The tracker service origin is not implicitly allowed for recording: to record its demo pages, register its exact origin as the company domain.

Set `PUBLIC_ORIGIN` in the tracker's `.env` to its own canonical URL, for example `http://localhost:3000`. Open login/dashboard pages at this exact origin because authentication POSTs are protected against cross-origin requests. Production requires HTTPS.

Your site's CSP must permit the tracker origin in `script-src` and `connect-src`. No password, cookie, or account token goes in the embedding snippet. Capture uses encrypted browser buffers when Web Crypto is available; the compatibility fallback on insecure local virtual hosts uses unencrypted memory.

Add the tag to a PHP shared header, a Blade/WordPress template, a frontend application's HTML entry point, or the appropriate script component in your framework. Include it once; repeated copies are ignored. Navigating to another document starts a new recording only if that document also includes the tag.

## PHP MVC views and AJAX partials

A view does not need its own `<head>`. Put the standard tag anywhere in its rendered HTML (outside PHP code blocks), or in a shared layout:

```html
<script data-universal-tracker src="http://localhost:3000/tracker.js" defer></script>
```

Use your actual tracker URL and register the **browser page's origin** in your account. The recorded URL is the browser URL (for example `/customers/edit/42`), not the server's PHP view filename. A file that is not included in the HTML response cannot start recording.

The widget handles normal body/footer placement, script elements inserted after page load, and partial loaders which evaluate downloaded code while the original tracker tag remains in the document. The optional `data-universal-tracker` marker identifies the tag even if you rename the widget URL. Repeated tags on the same document share one recording. Recording begins when the widget executes and the DOM is ready; earlier actions cannot be recovered.

**AJAX/innerHTML:** Browsers do not execute script tags inserted through `innerHTML`. Prefer loading the tracker once in the shared layout; it then captures subsequent rendered partial content. If there is no shared layout, explicitly load it from your existing AJAX success callback:

```js
// Run this as JavaScript after inserting the partial, not as inert innerHTML.
if (!window.UniversalTracker) {
  const tracker = document.createElement('script');
  tracker.src = 'http://localhost:3000/tracker.js';
  tracker.dataset.universalTracker = '';
  document.body.appendChild(tracker);
}
```

Saving rules are unchanged: normal form submissions and page navigation actions save; browser refresh does not. For a cancelled AJAX form, call `await UniversalTracker.save()` after success, or `await UniversalTracker.reload()` if the action should save and reload. A partial replacement alone continues the current page recording.

## Run and try it

Requires Node.js 22+, MySQL, and Chrome or Playwright Chromium:

```sh
npm install
npm run setup
npm run db:init
npm start
```

MySQL defaults: `localhost:3306`, user `root`, password `root`, database `universal_tracker`. Setup creates a signing secret in an ignored, mode-0600 `.env` without overwriting existing settings.

- **http://localhost:3000/page-demo.html** — a page with no form. Type, change its content, then follow Continue or click its ordinary JavaScript reload button.
- **http://localhost:3000/demo.html** — an existing form plus navigation actions; the form has no tracking attribute.
- **http://localhost:3000** — sign up/log in, then click a session ID to open its details and MP4.

MP4 generation is asynchronous. The dialog displays queued/processing/ready/failed states and offers retry after a failure. Playback and download are video-only; the old timeline viewer/export has been removed.

Installed `/usr/bin/google-chrome` is detected automatically. Otherwise run `npx playwright install chromium`, or set `CHROME_PATH`. The `ffmpeg-static` dependency supplies the encoder. Chromium's OS sandbox is enabled by default.

## Move the tracker to another server

1. Copy this project (including `package.json`, `package-lock.json`, `src/`, `client/`, `shared/`, `scripts/`, `public/`, and `.env.example`). Do not copy `node_modules`. For a fresh installation, leave out `.env` and `uploads/`.
2. Install Node.js 22+ and MySQL on the destination. In the project folder run:

   ```sh
   npm ci
   npm run setup
   npx playwright install --with-deps chromium
   ```

3. Edit the newly generated `.env`. Keep its generated secrets and set the database credentials and your domains:

   ```env
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=3000
   PUBLIC_ORIGIN=https://tracker.example.com
   DB_HOST=localhost
   DB_PORT=3306
   DB_NAME=universal_tracker
   DB_USER=your_database_user
   DB_PASSWORD=your_database_password
   TRUST_PROXY_HOPS=1
   ```

   The database account must have permissions needed by `db:init`. `TRUST_PROXY_HOPS=1` assumes exactly one trusted reverse proxy; adjust it for your deployment.

4. Run `npm run db:init`, then `npm start`. Keep the service running with your server's service manager. Configure an HTTPS reverse proxy for `tracker.example.com` to `127.0.0.1:3000`, allowing request bodies of at least 8 MB. Check `https://tracker.example.com/health`.
5. Add the script tag from the integration section to only the pages you want recorded. The other project needs no Node/MySQL installation or copied tracker source; it uses this running service.
6. Schedule `npm run db:prune` daily from this project folder. Open the tracker dashboard and create an account with the project origin, then log in to view its sessions.

To preserve existing recordings when moving servers, stop the old tracker, back up/import its MySQL database, and copy the complete `uploads/recordings/` directory with private permissions. Transfer `.env` securely and update host/domain settings. Run only one tracker process against a recording directory. Existing JSON captures are readable for upgrade compatibility; successful video jobs remove their capture files, and old JSON status files convert to binary metadata. Old captures without a full-page snapshot cannot produce a video and are retained until normal retention cleanup.

For the current installation, restart `npm start` after updating the code, then reload embedded pages to get the latest widget. Run `npm run db:init` before restarting to apply the additive account/session schema migration.

## Account security and session details

Signup stores name, normalized email, a salted scrypt password hash, and the exact company origin in `accounts`. Login uses a cryptographically random cookie; MySQL `login_sessions` stores only its SHA-256 hash and a 12-hour absolute expiry. Cookies are HttpOnly and SameSite=Strict, and Secure when `PUBLIC_ORIGIN` is HTTPS. Login rotates the current session, logout revokes it server-side, and authentication endpoints are rate-limited. Cross-origin authentication and retry POST requests are rejected.

After login, the dashboard lists only recordings whose `account_id` matches the logged-in account. A session link opens `/session.html?id=<recording-id>`, with session/recording IDs, account name, company origin, visitor name/ID, page URL/title, browser user agent, time, duration, capture counts, save trigger, and video playback/download/retry.

Use the same plain tag in any project that renders HTML:

```html
<script src="https://tracker.example.com/tracker.js" defer></script>
```

No username, user ID, query parameter or framework-specific template code is required.
Visitors are assigned anonymous analytics IDs automatically.

Upgrade steps: stop the server, run `npm run db:init`, then `npm start`. The migration preserves existing recordings and adds nullable ownership/metadata columns. **Historical recordings remain unassigned and hidden from new accounts**; do not automatically assign them based on a signup domain. A trusted operator can explicitly assign verified historical recordings to the correct account in MySQL. Old in-flight tracking tokens must be refreshed by reloading the host page.

`ADMIN_TOKEN` and `ALLOWED_ORIGINS` entries in existing environment files are ignored and can be removed. Domain availability is checked during signup. Password reset and email verification are not implemented.

## When a page is saved

1. At DOM readiness, the script starts rrweb capture without searching for any form. It initializes a signed, origin-bound page session.
2. Captured page events use encrypted browser memory where Web Crypto is available, with an unencrypted-memory compatibility fallback. An initial snapshot and incremental checkpoints are uploaded while the page is open, normally every two seconds, with extra checkpoints after input changes/actions.
3. Normal same-window HTTP(S) links and uncancelled native form submissions wait up to 3.5 seconds for the latest capture to save, then continue. The form's existing submit handlers run once; submitter values/action/method overrides are retained.
4. Synchronous button handlers that call `location.reload()` or redirect use a small `pagehide` keepalive request to finalize the checkpoint. Browser refresh/F5, browser back/forward, and tab closure do not finalize recordings or generate videos. Small in-flight checkpoint requests also use keepalive. The server coordinates finalization with their event sequence; if an expected tail never arrives, it can finalize the available prefix after six seconds and mark it truncated.
5. Finalization creates one MySQL recording per page session, stages its accumulated timeline in temporary binary storage, and queues MP4 generation. Retries are idempotent. BFCache restoration starts a new session.

**Page mode now temporarily stores capture data before navigation.** It replaces the earlier submit-only/abandonment-discard behavior. Temporary files live privately under `uploads/recordings/.pending/`; they are not listed in the session library. Finalized drafts are removed, and the pruning command removes stale drafts after 24 hours.

Cancelled AJAX submits, hash links, new-tab links/forms, downloads, and ordinary non-navigation buttons do not intentionally end the current page session. SPA route changes within the same document stay in one recording until save/navigation; use the API below if you need an explicit boundary. Very late application listeners that change native event behavior should be tested with your framework.

## Custom JavaScript action buttons

Existing synchronous button handlers using `location.reload()` or `location.href = ...` work through the exit/checkpoint fallback. Delayed actions (timers, AJAX responses, async handlers) must use the API below to identify an intentional save; button intent is cleared after the click task so later browser refreshes do not save. For a custom action that must flush the latest events **before** navigating, use the provided asynchronous hook:

```js
// Recommended for a custom reload action:
await window.UniversalTracker.reload();

// Or save then navigate:
await window.UniversalTracker.navigate('/next-page.php');

// Save the current page without leaving:
const result = await window.UniversalTracker.save();
// result: { status: "saved", recordingId } or { status: "error" }

// Upload a temporary checkpoint without finishing the page:
await window.UniversalTracker.checkpoint();
```

A saved session is complete; later saves in the same document return the same recording ID. `recording:complete` is dispatched on `document` after an explicit/normal-navigation save:

```js
document.addEventListener('recording:complete', (event) => {
  // event.detail.status and event.detail.recordingId
});
```

The default is fail open: tracking failure allows navigation/form submission to continue. Add `data-recording-fail-closed="true"` to the script only if your application must require acknowledgement before intercepted navigation. Direct browser/application navigation cannot be blocked reliably by this option; use the explicit API for controlled actions.

No browser script can guarantee an upload after abrupt process termination, offline shutdown, or every mobile tab closure. Action-triggered exits may save only the latest delivered checkpoint and miss the final moments. Browser refresh/closure leaves only an unfinalized private draft, removed by the existing stale-draft pruning job; it creates no library recording or MP4. An exit before initialization/initial snapshot delivery cannot produce a useful video. These are browser lifecycle constraints, not differences between PHP and JavaScript websites. See [MDN pagehide](https://developer.mozilla.org/en-US/docs/Web/API/Window/pagehide_event) and [keepalive body limits](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit).

## Identity and privacy

The plain script tag records anonymous visitors without host authentication integration.
It cannot automatically access a Python, JavaScript, PHP or other application's authenticated
identity. It does not infer names from form inputs or inspect authentication tokens.
Existing optional host-provided identity attributes remain supported for compatibility;
they are metadata, not authenticated proof, and are not required for recording.

Load the script only after any consent required by your site's policy. It has no visual interface, permission prompt or console logging. The analytics foundation uses optional first-party localStorage for anonymous visitor continuity; set data-analytics-storage="none" to disable persistent identity storage. Passwords, hidden/file inputs, common credential/payment fields, and explicit masks are redacted. Ordinary page text and non-sensitive inputs, including inputs outside forms, are captured.

```html
<input name="private_reference" data-recording-mask />
<section data-recording-mask>Mask this text and its fields</section>
<div data-recording-ignore>Exclude this subtree</div>
```

Apply privacy attributes before capture. URL query strings/fragments, executable DOM content, arbitrary data attributes, event-handler attributes, and external image/link URLs are removed from page events. Do not place secrets in paths, identifiers, labels, or unmasked text. Browser event buffers use AES-GCM encryption where available (otherwise an unencrypted-memory fallback), but same-page malicious scripts can still read the original DOM. Binary checkpoints, binary job metadata, and MP4 files are private mode-0600 files, **not encrypted at rest**; use encrypted storage/backups if needed.

## Video scope and limits

The MP4 replays the recorded DOM, accessible inline CSS, input changes, clicks, pointer movement, scrolls, and layout changes. It is a reconstructed page session, not operating-system screen capture, and has no audio. External assets unavailable to the captured DOM, iframe contents, canvas/WebGL/video pixels, and browser chrome cannot be reproduced faithfully. The isolated renderer blocks all outbound network requests.

The page buffer is bounded to 6 MB and 15,000 events. Capture stops at the first dropped event to prevent an invalid mutation chain; partial captures are marked truncated. Checkpoint metadata includes at most 100 input fields. Requests are limited to 8 MB, and small exit requests stay below the browser keepalive budget. Very large pages may not yield an initial snapshot. Session tokens expire after four hours by default.

Videos default to 10 fps, up to 1920 × 1080, and a 10-minute maximum. Configure `VIDEO_FPS=1..30` and `VIDEO_MAX_SECONDS=1..3600`; larger exports need more CPU/disk. Processing happens in one background worker and does not hold up navigation.

Older form-only JSON cannot be turned into a full-page video. Record a new visit with the current tracker.

## Files and API

The only recording output is MP4. Internal binary files support rendering, retry and crash recovery; HTTP payloads still use JSON. No new JSON recording/status files are generated.

Storage:

- `uploads/recordings/<id>.capture.gz` — temporary compressed binary render input; deleted after successful video generation. Failed jobs retain it for retry.
- `uploads/recordings/<id>.video` — small binary job-status metadata (not a recording export).
- `uploads/recordings/<id>.mp4` — H.264 MP4.
- `uploads/recordings/.pending/<session-id>.capture.gz` — private, temporary page checkpoint.

Public ingestion endpoints require an allowed `Origin`:

- `POST /api/track/init` — issue page token; stores no recording itself.
- `POST /api/track/page/checkpoint` — append ordered event batches.
- `POST /api/track/page/finish` — finalize once; accepts JSON or text/plain JSON for keepalive.
- `POST /api/track/submit` — retained for legacy form mode.
- `GET /tracker.js` — bundled widget; revalidated on load.
- `GET /health` — MySQL-backed readiness.

Dashboard routes require the account login cookie; bearer administrator tokens are no longer accepted. Every recording, video, status, and retry endpoint enforces account ownership:

- `GET /api/admin/recordings`
- `GET /api/admin/recordings/:id` — session metadata for the owning account.
- `GET /api/admin/recordings/:id/video/status`
- `GET /api/admin/recordings/:id/video` (supports ranges)
- `POST /api/admin/recordings/:id/video/retry`

The HttpOnly login cookie is sent automatically for same-origin video playback and downloads. It never appears in a video URL.

## Legacy form-only mode

Existing deployments needing submit-only behavior can explicitly select it:

```html
<script src="https://tracker.example.com/tracker.js" data-recording-mode="form" defer></script>
<form data-recording-enabled="true">...</form>
```

That mode retains its original per-form buffers, optional form-level user ID, submit interception, and abandonment discard. Page mode is the default; it ignores the old form opt-in attribute.

## Development and operations

```sh
npm run dev
npm run build
npm run format
npm run format:check
npm run check
npm test
npm run test:browser
npm run test:video
```

Edit `client/page-tracker.js`, `client/page-capture.js`, or `client/form-tracker.js`; `public/tracker.js` is generated. Start/dev rebuild the browser bundles before launching. Rebuild manually after changing client sources during a server watch session.

Tests cover page-only capture, separate origins, native forms, AJAX cancellation, direct/explicit reloads, privacy, ordered checkpoints, duplicate finalization, legacy compatibility, and real MP4 encoding/playback. Test recording data is isolated in temporary storage. Video inspection artifacts are written under `/tmp/`.

For production use HTTPS, a restricted MySQL user, fresh secrets, exact allowed origins, an 8 MB proxy body limit, and the correct `TRUST_PROXY_HOPS`. Reverse-proxy to Node; do not expose this project folder directly via Apache/Nginx. Build with development dependencies, then optionally prune them and run `node src/server.js`.

Run `npm run db:prune` daily to remove expired recordings/videos and stale temporary checkpoints. `RETENTION_DAYS` defaults to 30. Back up MySQL and final recording files together. Monitor filesystem usage: the dashboard storage statistic counts initial compressed capture size, not MP4/draft bytes.

Use one server process per recording directory. Page draft locks, video job ownership, and rate limits are process-local; multi-instance deployments need distributed coordination/storage. The per-IP ingestion limit is 120 requests/minute, so account for concurrent tabs/users behind a shared IP. Public origin restrictions are not client authentication. Keep Chromium's OS sandbox enabled.

Capture/replay uses [rrweb](https://rrweb.com/docs/guide).

## Master administrator

Open /master/admin/login on the tracker service. The initial login is admin@admin.com / admin@123, as requested for this installation. The password is stored as a salted hash in MySQL. Running npm run db:init creates it once and does not reset an existing master password.

After login, /master/admin lists registered companies, their domain, email, and recording count. Click a company to browse its sessions, then a session ID for details and MP4 playback/download. Master and company logins share the session cookie: logging into one replaces the current login in that browser.

Master access is checked from the MySQL is_master role on every authenticated request. Signup cannot grant this role. Normal accounts cannot access company listings or other companies' recordings. The master account has no tracking origin. Existing unassigned recordings are not automatically attached to companies.

## Analytics foundation (increment 1)

The additive migration creates `projects`, `visitors`, `tracking_sessions` and
`session_pages`. Existing recording IDs, login sessions, MP4 files and routes remain
unchanged. Run `npm run db:init` before starting the updated server.

The page widget initializes analytics independently of recording finalization.
A refreshed or abandoned page can therefore have an analytics record without an
MP4. Semantic activity now includes clicks, scroll milestones, forms, visibility,
SPA page views and bounded engagement samples. Observed span and engagement remain
estimates, not guaranteed actual dwell time. Reporting/dashboard implementation is
separately gated for review.

A signed, project-scoped anonymous visitor credential is stored in the host site's
localStorage. Set `data-analytics-storage="none"` on the script to use memory-only
identity. Blocked storage also falls back to memory. Identity is not fingerprinted
and is not proof of an individual person. Existing host consent/loading policies
must include this storage behavior.

`ANALYTICS_SESSION_TIMEOUT_SECONDS=1800` configures the default inactivity timeout.
A project's nullable `inactivity_timeout_seconds` overrides that default for new
sessions. Existing sessions retain their assigned timeout.

Definitions: [analytics metric dictionary](docs/analytics-metrics.md).
Isolated MySQL regression check: `node scripts/test-analytics-db.js` (requires
permission to create/drop its own randomly named test database).

## Semantic activity (increment 2)

Run `npm run db:init` before restarting. The additive migration adds
`semantic_streams` and `session_events`, and allows multiple SPA page views per
recording. The recording pipeline and MP4 finalization rules are unchanged.

[Implementation, sample JSON, reporting SQL and dashboard proposal](docs/semantic-increment-review.md).

Capture sends no raw field values in semantic events. For custom sensitive fields,
use `data-recording-mask` or `data-analytics-redact-selectors` on the tracker script.
Only explicit `data-analytics-label` text is eligible for click labels. A browser
submit remains an attempt; call `UniversalTracker.confirmFormSuccess(formElement)`
only after your application confirms success.

New endpoints: `POST /api/track/analytics/events` and authenticated
`GET /api/admin/sessions/:id/events?offset=0`. Session/event reads remain account-scoped.
The response contains at most 200 timeline events with a next offset when applicable.

Pending sanitized event batches use bounded tab-local sessionStorage, unless
`data-analytics-storage="none"` is set. This supplements memory retries; it cannot
guarantee recovery after tab closure, storage clearing or process termination.

### Analytics dashboard

The workspace includes semantic analytics, filters, a session journey/timeline and existing MP4 playback. See [dashboard definitions and limits](docs/dashboard.md). This increment adds read-only reporting; no migration or tracking configuration change is needed.

### Session identity, location and replay format

New visits store a tenant-scoped document context independently of video finalization. Run `npm run db:init` after updating. The additive `recording_contexts` table is keyed by `(account_id, recording_session_id)` and references accounts; document sessions/pages associate using the same signed recording ID. It stores explicit host identity, server-observed IP, approximate IP location, browser user agent, browser timezone/language, viewport and referrer origin. Query strings, cookies, passwords and form values are not used for this context.

Profile & integration provides a universal plain script tag without identity parameters.
Browser and available network/location metadata are captured automatically; logged-in names
cannot be discovered reliably without explicit host integration. Old sessions cannot recover
identity or network metadata that was never captured.

IP location uses local GeoIP-lite/GeoLite data from MaxMind, not a third-party lookup request or browser GPS. Local/private IPs show location unavailable. IP locations are approximate and may reflect VPN/proxy egress; behind a reverse proxy, configure `TRUST_PROXY_HOPS` only for the actual trusted deployment topology. The bundled dataset is a snapshot: update the GeoLite data using your MaxMind license according to https://github.com/geoip-lite/node-geoip#update-the-datafiles before relying on production locations. This product includes GeoLite data created by MaxMind, available from https://www.maxmind.com/. The installed GeoIP package's database updater has dependency audit findings in its IP-address helper; the tracker does not invoke that updater or its HTML/IP parsing helpers at runtime and validates observed IPs with Node's `net.isIP` before lookup.

New videos default to VP9 WebM (`VIDEO_FORMAT=webm`). `VIDEO_FORMAT=mp4` selects the previous H.264 encoder. Existing MP4 files are preserved and served with their original MIME type/extension. WebM uses quality-based compression; size savings vary with page activity. The detail page provides Details, Session replay and Event log tabs; it does not issue certificates or verify consent. Downloads, byte-range playback, retries and retention support both formats.

### Server-side authenticated identity helper

`src/authenticated-identity.js` exports `authenticatedIdentity(account)`, returning only
`{ id, name }`. Pass the account resolved by your server's validated session/database
adapter after authentication. Names must be strings of at most 160 characters before
trimming and must remain nonempty after trimming. Invalid identity throws
`AuthenticationError` (`AUTHENTICATION_REQUIRED`, HTTP 401). The helper does not mutate
accounts or return credentials.

The function has no Express, HTTP, cookie or storage dependencies. This JavaScript
implementation can be reused in JavaScript server frameworks. Python, Java, PHP and
.NET must implement the same small validation contract in their own language and
resolve their own authenticated sessions; a JavaScript file cannot read those runtimes'
sessions automatically. Never pass request bodies, query parameters, headers, browser
storage or client-provided identity objects to this helper.

The existing portal still uses its opaque session cookie solely to locate and validate
the database session. The username comes from the associated database account, never
from that cookie. Login, signup and `/api/auth/me` responses use the helper while retaining
their existing response fields. Signup first persists and reloads the account; login
verifies the existing password before using its database account. This does not add
cross-site visitor identification or change the public tracker/frontend.

### Success-only recordings across validation reloads

Configure explicit rules in the **tracker server's** `.env` and restart it:

```dotenv
RECORDING_SUCCESS_RULES='{"https://yourwebsite.com":{"path":"/thank-you","selector":".submission-success"}}'
```

Rules are keyed by exact registered origin. `path` is an exact pathname (no query/hash),
`selector` must match a visible element; when both are supplied both must match. These
are browser-observed signals configured by the operator, not verified backend outcomes.
A 200 or redirect response alone never means success. Origins without rules retain
existing action-triggered recording. The profile page shows the active rule.

Keep the same plain script tag on **every form, validation-error and success page**,
usually via a shared layout. No framework-specific template logic is needed. A script
only on the original form cannot observe an uninstrumented destination. This tracker
change does not edit host project files or rewrite native forms into AJAX.

In success mode a submit attempt checkpoints without stopping capture. Same-tab,
same-origin page reloads continue the journey via sessionStorage containing only scoped
signed recording references/counts, never form values. A matching success page/element
after a submit attempt finalizes one combined video with all available page snapshots.
For AJAX integrations, `UniversalTracker.confirmFormSuccess(form)` also finalizes after
the host explicitly reports success. `save()`, `navigate()` and `reload()` only checkpoint
in success mode. Normal browser refresh/closure does not finalize.

Continuation expires after 30 minutes without an acknowledged checkpoint, or earlier
when a recording token expires. Limits: 20 documents, 15,000 combined events and 7 MiB
combined event data; the existing encoder duration cap still applies. Failed/incomplete
assembly retains private captures for retry instead of silently dropping earlier pages.
Blocked tab storage, cross-origin redirects and pages without the script cannot provide
reliable continuation. Duplicating a tab may copy its browser sessionStorage; start a
fresh independently opened tab for a separate journey. Run the existing pruning job to
remove abandoned drafts. Earlier-page semantic events remain available in the timeline;
video seeking is currently offered for the final document with its combined-video offset.

When a completion signal never arrives, Session replay shows the number of pending
captures. An authenticated owner can choose **Generate captured replay** after closing
the tracked pages and waiting 30 seconds without checkpoints. This explicitly ends and
combines the available drafts into a manual recording; it does not assert successful
submission. Recovery is tenant-scoped and CSRF-protected. Active captures are rejected,
and existing success-only auto-finalization rules are unchanged.

### Optional host-provided visitor identity (any framework)

The tracker supports an explicit data contract, not server-session discovery. On the
host page, expose only the authenticated visitor's public ID and display name as the
string properties `id` and `name` of `window.pageTrackerData`. Supply the object before
the tracker loads when possible. Use your framework's safe JSON serialization when
embedding server values; do not concatenate raw user strings into HTML or JavaScript.
Do not include passwords, tokens, session data or API keys. Extra object keys are ignored.

Alternatively, explicitly mark two hidden inputs with `data-page-tracker-user-id` and
`data-page-tracker-user-name`, with their HTML-escaped values populated by the host.
The tracker does not infer identity from arbitrary `name`, `username`, email or other
form inputs. Hidden inputs with credential-like names/IDs or recording mask/ignore
markers are excluded. Ordinary capture still redacts all hidden inputs.

Precedence is whole-source: an explicitly present `window.pageTrackerData` object,
then marked hidden fields, then legacy form/script/html/body data attributes. Values
from different sources are not combined. Duplicate marked fields are ambiguous and
produce anonymous identity. IDs and names must be strings of at most 160 characters;
blank/invalid values become null, without string coercion or truncation.

For late login/account changes, replace the object and dispatch the
`page-tracker:identity-change` event on window or document. Event detail is ignored;
the resolver rereads the explicit data source. Page mode also checks on periodic
checkpoints; legacy form mode rereads on submit. For logout set
`window.pageTrackerData = null` and dispatch the same event. Null is authoritative
and prevents stale hidden fields/attributes from restoring the old identity.

Identity updates use the existing origin-bound recording token and account scope.
Context updates preserve server-observed IP/browser data. Session details use the
latest captured document context and retain the “not independently verified” label.
Recordings retain the identity snapshot at finalization; old recordings are not
backfilled. This feature does not authenticate the visitor, change tenant authorization,
or alter the Page Tracker account login helper. No identity is stored in browser storage.
Host projects must supply the object/marked fields; this repository change does not
modify any host project or make identity appear when no host data is provided.

### Host user IDs and analytics visitor counts

At each new recording initialization, an explicit host `user_id` creates a stable
analytics visitor scoped to the owning account and page origin. Two host user IDs
in the same browser therefore get separate visitors and analytics sessions. Names
alone do not identify users. The same host user ID reuses its own active session
within the configured inactivity timeout. After logout, omit/clear the host ID;
an identified visitor credential is not accepted as an anonymous identity.

The host must supply the ID through the existing identity integration. Tracker
cannot read server-side login sessions automatically. Existing historical records
are not reassigned. In-page identity metadata updates do not split an already
initialized recording; this rule takes effect at the next tracked page initialization.
