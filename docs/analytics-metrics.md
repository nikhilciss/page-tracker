# Analytics metric dictionary - version 1

Scope: project, UTC storage timestamps, explicit reporting timezone. Analytics sessions and recordings are different entities. Historical recordings without analytics associations are legacy data, not reconstructed visitor sessions.

- Stored visitor identity: when initialization supplies an explicit host user ID, a stable server-derived identity scoped to the account and project origin. Different host IDs in the same browser create different visitors and analytics sessions; the same host ID can return across pages/devices. Names alone never identify users. Without a host ID, use a random, signed browser identity. Host labels are not authentication proof. Never merge anonymous visitors by IP or user agent. Identified visitor credentials cannot be reused as anonymous credentials after logout. Existing history is preserved; the rule applies to new recording initializations.
- Dashboard Total visitors: distinct analytics session IDs in the filtered selection. Two analytics sessions count as two visitors even if the stored visitor identity or host user ID is the same. This is a visit count, not a unique-person count. The API exposes `totals.unique_identities` separately for the former identity-based metric. Historical recordings without analytics remain outside this metric.
- Dashboard new/returning breakdown: count analytics sessions, classified by whether the underlying identity first_seen_at falls within the reporting interval. API fields new_visitors/returning_visitors retain their names for compatibility; UI labels explicitly describe sessions.
- Returning visitor session: visitor had a previous analytics session when this session started. A visitor can have both new and returning activity in one reporting interval; do not present these as an exclusive partition of unique visitors.
- Session: a visitor's activity grouped until the configured inactivity deadline (default 1800 seconds). Server timestamps govern expiry. Different tabs share the visitor session; separate page IDs prevent duplicate page counts.
- Session status: active before last_activity_at + timeout; timed_out afterward. Timeout closure uses last observed activity as ended_at, not the timeout deadline. No observed exit must be presented as a confirmed browser close.
- Page view: one initialized document, or later one SPA route boundary. Initialization retries with the same signed recording session ID are idempotent. Refresh is a new page view, even without an MP4.
- Duration: max(0, last_activity_at - started_at). Not video duration or engagement.
- Interaction: accepted semantic click, input-start, form action or other explicitly enumerated user action. Mouse samples, DOM mutations, heartbeats and automatic navigation are not counted as user interactions.
- Engagement: union of observed foreground active intervals across pages/tabs, with inactivity gaps excluded. Do not sum overlapping tab durations. Visible, recently active intervals are now sampled; session-wide union is proposed in semantic-reporting.sql and is not yet a dashboard metric.
- Recording: a finalized existing recording row. MP4 status (queued/processing/ready/failed) is separate from analytics session status.
- Form start: first field interaction in a form instance, counted once.
- Submission: submit attempt; not confirmed success.
- Successful submission: explicit host success signal or a configured success condition, never inferred only from submit.
- Abandonment: inferred started form without confirmed completion after page/session inactivity. Unknown outcome is distinguishable from confirmed failure.
- Scroll depth: clamped maximum viewport-bottom / scrollable document height, with document-size changes recorded. Depth milestones deduplicated per page.
- Pages/session: page view count divided by analytics sessions in the same defined cohort.
- Session counts, visitors and recordings use their own timestamps and denominators. No-data values remain unavailable, not fabricated zero values.

## Phase boundaries

Phase 1 establishes project/visitor/session/page storage, signed visitor continuity and account-scoped reads. Rich events, engagement aggregation, forms, SPA route handling, reporting and viewer synchronization follow in separate tested increments.

Raw input values, arbitrary query strings and fragments are excluded from this foundation. URL paths can still contain personal information: customers must avoid sensitive path values; configurable path redaction belongs to the capture increment.

The existing MP4 save-on-action behavior is unchanged. Analytics creation and heartbeat never finalize a recording.

Semantic increment details: [capture and ingestion review](semantic-increment-review.md).
