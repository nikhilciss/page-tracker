# Semantic activity increment - implementation and dashboard review

The dashboard is unchanged. This document is the review boundary before dashboard implementation.

## Implemented data layer

Normalized page_view, navigation, click, scroll_milestone, form_view, form_start,
form_field_interaction, form_submit, form_validation_attempt, form_success,
visibility_change, engagement and page_exit events. The server adds session_start
and inferred_timeout. A page_exit is not a confirmed session end. Inferred timeout
is materialized on analytics initialization or session/timeline reads; it is not an
exact browser-close timestamp.

An event's account/project/visitor/session/page are resolved server-side from the
signed recording context. Payload ownership IDs are rejected. Composite foreign
keys enforce page/session/visitor relationships. Event IDs and document sequence
numbers are deduplicated in a transaction; conflicting retries and gaps are rejected.

Replay events still use the existing compressed recording files. MySQL stores
semantic events only, indexed by project/session/time and project/type/time.

## Requested review artifacts

1. [Sample session JSON](samples/semantic-session.json).
2. [Sample event records](samples/semantic-events.json).
3. [Proposed reporting SQL](semantic-reporting.sql).

These samples are generated from isolated automated browser tests, not customer
recordings. They intentionally include localhost test URLs and synthetic identities.

## Capture and privacy contract

- No key characters or input values in semantic payloads. Field/form identifiers are generated labels.
- Password/payment/authentication identifiers are sensitive; field events retain type and interaction metadata only.
- Text is omitted by default. An explicit `data-analytics-label="Get Started"` provides a bounded, sanitized static label. It must not contain personal data.
- `data-recording-mask` and `data-recording-ignore` remain supported.
- `data-analytics-redact-selectors=".private,[data-sensitive]"` masks configured fields/text in page replay and suppresses semantic element details. Invalid selectors fail conservatively.
- URLs omit query strings and arbitrary fragments. Hash routes beginning #/ or #!/ produce page views; only restricted static route labels are retained. Set `data-analytics-hash-routes="false"` to disable hash-route boundaries. Query-only state changes are not page views.
- Form success is emitted only through `UniversalTracker.confirmFormSuccess(formElement)`. This is a host-reported signal, not independent server verification. Ordinary browser submit events remain attempts.

## Batching, retries and recovery

- At most 30 events and roughly 30 KB per normal batch; the server enforces 50 events and 64 KB decompressed JSON.
- Normally flush about every two seconds; exponential retry backoff capped at 30 seconds with jitter and a six-failure retry budget. Online notification resumes a paused retry queue.
- Gzip used when CompressionStream is available and the batch exceeds 4 KB. Exit batches remain small keepalive requests.
- Queue bounded to 200 events. Overflow stops semantic capture and marks it partial instead of silently inventing sequence continuity.
- Sanitized pending events can be persisted in sessionStorage for up to four documents, each under 120 KB, expiring after one hour. Current-tab reload recovery retries original IDs. Tab closure/crashes and browser storage clearing can still lose the unacknowledged tail.
- `data-analytics-storage="none"` disables persistent visitor/outbox storage; memory-only retry remains.
- `UniversalTracker.analyticsStatus()` reports partial/paused/pending state. `analyticsFlush()` supports an explicit best-effort flush.
- Analytics failure does not block forms, navigation or existing MP4 recording.

## Timing and measurement limits

Events carry monotonic document offsets and a bounded client-clock timestamp.
The initial stream clock anchors the timeline; database observation and client
clock precision still differ. Page/session start is adjusted to the accepted
stream start. Clocks more than a day behind or more than five seconds ahead are
rejected. Recording offsets are relative to capture startup; final frame-alignment
validation belongs to the replay-viewer increment.

Engagement samples only visible, recently active intervals, capped at 15 seconds
since last user activity. Page engagement is an estimate. Use the proposed interval
union query across tabs; summing page totals would overcount simultaneous tabs.
`observed_ms` is the observed page span, not guaranteed actual dwell time. Browser
termination/offline gaps cannot be reconstructed reliably.

The existing signing-token lifetime still bounds collection. A timeout can split
analytics sessions without splitting the MP4/document stream. Active sessions are
reused across tabs when the accepted event timestamp fits the inactivity window.

## Proposed metrics

- Sessions and participating visitors: analytics tables, independent of recordings.
- New visitors: first_seen_at in the selected interval; returning_sessions is a
  separate session metric, not an exclusive partition of visitors.
- Page views: session_pages rows, including SPA routes and refreshes.
- Interactions: enumerated semantic actions; not rrweb event count.
- Browser submissions: form_submit count. Host-reported successes shown separately.
- Abandonment: future inferred status after inactivity; never equated with confirmed failure.
- Maximum depth and milestone reach: page-level observations.
- Observed span and engagement estimate: explicitly labeled, not precise total time.
- Recordings: existing finalized recordings and MP4 state, not total sessions.

Device, browser distribution and traffic breakdown cards require the later rich
context increment. They should not appear with invented values or dummy charts.

## Proposed chronological timeline

```text
00:00  Session started                       [server]
00:00  Page viewed: /contact                 [document 1]
00:02  Form viewed: form-1
00:05  Click: Get Started
00:08  Form started: form-1
00:09  Password field focused                [metadata only]
00:12  Browser submit attempt                [outcome unknown]
00:13  Host reported form success            [only explicit signal]
00:15  Navigation: /pricing                  [pushState]
00:15  Page viewed: /pricing                 [same MP4/document]
00:18  Scroll milestone: 75%
00:21  Tab hidden
later  Inferred timeout                     [last observed activity]
```

A timeline item will select the document's recording and seek by recording offset.
If no MP4 exists, the event remains inspectable with a “No finalized recording”
label. Events beyond the MP4's available/truncated duration must not seek to a
misleading frame. Server-only boundary events without a usable recording offset
will not offer video seeking.

## Proposed dashboard structure - not implemented

```text
Sidebar: Overview | Sessions | Visitors | Integration

OVERVIEW                          Project / Date range / Timezone
Sessions | Visitors | Page views | Recordings
Interactions | Form starts | Browser submits | Host-reported success

Sessions and visitors over time      Page activity / Scroll reach
Observed duration and engagement    Form activity (attempt vs success)

Recent sessions: status, visitor, start, observed span, pages,
interactions, landing/exit URL, recording availability
```

```text
SESSION DETAILS
Visitor / Session status / Started / Last activity / Observed span
Pages / Interactions / Engagement estimate / Recording availability

Page journey selector               Session context
MP4 viewer (existing pipeline)       Forms / Scroll depth / Status
Play / Pause / Speed / Previous event / Next event
Marker strip: Click | Scroll | Form | Navigation

Chronological event list            Sanitized event inspector
Click event -> choose document recording -> seek
```

Mobile: filters collapse into a panel, cards wrap, session rows use horizontal
scroll, and the detail inspector sits below the player. Include real loading,
empty, partial-session and error states. No major frontend changes until approval.

## Validation

Unit/API checks cover schema limits, compressed request limits, forged ownership,
invalid tokens and redaction. Isolated MySQL/Chrome checks cover initialization,
returning sessions, refresh, concurrent starts, SPA navigation, event sequencing,
duplicate retries, timeout rollover, fields/forms, scroll, hidden engagement,
desktop/mobile, offline pause/retry, reload recovery and multiple tabs. Existing
account, recording and MP4 suites remain the compatibility gate.

Commands: `npm test`, `node scripts/test-analytics-db.js`, `npm run test:browser`,
`npm run test:video`. The database script creates and drops only its own randomly
named disposable database. To regenerate fixture samples, set
`WRITE_ANALYTICS_SAMPLES=1` for that script.
