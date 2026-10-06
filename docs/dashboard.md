# Analytics dashboard

The workspace overview now reads captured analytics independently of finalized recordings. Existing recording URLs and the expandable recording library remain available.

Read-only endpoints:

- `GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&project=&device=&browser=&offset=0`
- `GET /api/admin/analytics/sessions/:id`

Both use the logged-in account as the authorization boundary. Dates are half-open UTC boundaries; the UI converts its inclusive end date. Metrics use sessions starting in the selected range and their captured lifetime activity. Recent sessions paginate in groups of 20. A selection exceeding 5,000 sessions is rejected with a request to narrow the date range/project, rather than silently reporting partial totals. Maximum date range: 366 days. Queries require the existing MySQL 8 foundation.

Total visitors counts distinct analytics session IDs, including repeat sessions from the same stored identity. The new/returning chart counts sessions grouped by whether their identity was first seen during or before the selected range. The API retains the distinct identity count separately as totals.unique_identities. Engagement is the union of captured engagement intervals per session, preventing overlapping tabs from double counting. Observed span is last activity minus session start, not exact dwell time. Daily trends use the session start day. Scroll reach counts page views reaching each depth.

Browser/device/OS are inferred from the first linked recording's stored user agent. Sessions without recording metadata remain Unknown. Referrer and UTM data are not stored, so attribution and its filter explicitly say Not captured. No new collection was introduced.

Session details show the page journey, paginated semantic timeline and existing MP4 status/player/download/retry. Event seeking uses the event page's document recording and recording offset; events outside the available video cannot seek. Browser submit attempts and host-reported success remain distinct. Historical recordings without analytics retain the original detail page.

Validation: `npm test`, `npm run test:browser`, `npm run test:video`, and `node scripts/test-analytics-db.js` (disposable database). No schema migration is required for this dashboard increment.

## Historical recording coverage

The filtered overview also includes account-owned recordings with no matching session_page, grouped by recording session ID (one recorded document visit, not an inferred analytics session). Date, project, browser and device filters apply to these rows. Linked recordings are excluded from this fallback to avoid double counting. Historical visits link to their existing MP4 detail page. Their duration is recording duration; visitor identity, engagement and semantic metrics remain unavailable. Coverage is shown explicitly; visitor/page-view/form/scroll/engagement reports cover analytics sessions only. Browser breakdowns and visit trends include both sources. Unassigned recordings are not attributed to a tenant automatically.

## Extended activity reports

The overview now adds saved recording counts, ready/processing/failed/unavailable video counts, country and top-IP distributions, top domains, referrer origins, observed session duration buckets, first-submit timing, input-method observations, sensitive-field interaction coverage and the latest ten matching recordings. Existing filters apply to these reports; country, exact IP, referrer origin and input method are additional filters. Pagination only affects the session table, not report totals.

A visit uses its first available document context for country/IP/referrer. Unknown is retained as a category and does not imply direct traffic or a geographic location. Domain totals count each visit once per domain, so multi-domain visits can appear in multiple bars. Historical visits remain distinct from analytics sessions. Saved recording counts deduplicate recording IDs even if one recording spans multiple analytics sessions. Ready counts require a ready worker status and an existing file. Context-free older records remain Unknown; historical visits do not enter observed-duration or submit-timing distributions.

First-submit timing uses the minimum form_submit page offset per page. It is neither lead age nor verified server success. Duration buckets are [0,10), [10,30), [30,60), [60,300), [300,900), [900,infinity) seconds. Session-duration distributions use last activity minus session start, not exact dwell time.

The updated widget adds a bounded input_method enum to form_field_interaction events: typing/editing, paste, drop, replacement, selection or unknown. Only one method observation per active field interaction burst/method is emitted; no clipboard content, input values or keystrokes are read. Replacement may include browser editing or autofill but is not labeled proven autofill. The report counts visits with each observed method; a visit can appear in several bars. Sessions without observations are Not captured, not No text input. Sensitive-field activity reports observed metadata flags, not a whole-recording masked/unmasked or compliance status.

Certificate issuance/retention, lead matching, verified consent, ownership verification and vendor attribution are not measured. The website HTTP availability check is not proof of ownership. No schema migration is needed for these reports.
