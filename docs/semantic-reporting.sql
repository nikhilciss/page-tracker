-- PROPOSED reporting queries, not dashboard code. MySQL 8.
-- All ? placeholders must be bound; account comes from the login session.
-- Use half-open UTC ranges [from,to), with explicit UI timezone conversion.

-- Session count, unique participating browser identities and observed span.
SELECT COUNT(*) sessions, COUNT(DISTINCT visitor_id) unique_visitors,
       AVG(GREATEST(0,TIMESTAMPDIFF(MICROSECOND,started_at,last_activity_at))/1000) observed_span_ms,
       SUM(returning_visitor=1) returning_sessions
FROM tracking_sessions
WHERE account_id=? AND project_id=? AND started_at>=? AND started_at<?;

-- Daily trends; these are observed sessions, not finalized videos.
SELECT DATE(started_at) utc_day,COUNT(*) sessions,COUNT(DISTINCT visitor_id) visitors
FROM tracking_sessions WHERE account_id=? AND project_id=? AND started_at>=? AND started_at<?
GROUP BY DATE(started_at) ORDER BY utc_day;

-- Semantic actions: exclude raw replay events, visibility, engagement and lifecycle.
SELECT event_type,COUNT(*) events
FROM session_events
WHERE account_id=? AND project_id=? AND occurred_at>=? AND occurred_at<?
 AND event_type IN ('click','form_start','form_field_interaction','form_submit',
                   'form_validation_attempt','form_success')
GROUP BY event_type;

-- View-level depth: count unique page views at each reached milestone.
SELECT JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.milestone')) milestone,
       COUNT(DISTINCT page_id) pages_reached
FROM session_events WHERE account_id=? AND project_id=? AND occurred_at>=? AND occurred_at<?
 AND event_type='scroll_milestone' GROUP BY milestone;

-- Form starts and browser submits are different from host-confirmed success.
-- Group by page and generated form ID (not DOM name or raw field values).
SELECT page_id,JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.form')) form_instance,
       MAX(event_type='form_start') started,
       SUM(event_type='form_submit') browser_submit_attempts,
       MAX(event_type='form_success') host_reported_success
FROM session_events WHERE account_id=? AND project_id=? AND occurred_at>=? AND occurred_at<?
 AND event_type IN ('form_start','form_submit','form_success')
GROUP BY page_id,form_instance;

-- Observed engagement union across tabs. Do not SUM page.engaged_ms for a session.
-- Every interval ends at the engagement event; its bounded duration is metadata.engaged_ms.
WITH intervals AS (
 SELECT tracking_session_id,occurred_at finish_at,
 TIMESTAMPADD(MICROSECOND,-CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.engaged_ms')) AS SIGNED)*1000,occurred_at) begin_at
 FROM session_events WHERE account_id=? AND project_id=? AND occurred_at>=? AND occurred_at<?
 AND event_type='engagement'
), previous_intervals AS (
 SELECT *,MAX(finish_at) OVER (PARTITION BY tracking_session_id ORDER BY begin_at,finish_at
 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_end FROM intervals
)
SELECT tracking_session_id,
 SUM(GREATEST(0,TIMESTAMPDIFF(MICROSECOND,GREATEST(begin_at,COALESCE(previous_end,begin_at)),finish_at)))/1000 engaged_ms
FROM previous_intervals GROUP BY tracking_session_id;

-- Timeline: sequence is document-stream scoped; server lifecycle uses its own scope.
SELECT id,event_type,occurred_at,page_id,stream_id,sequence_number,
       page_offset_ms,session_offset_ms,recording_offset_ms,metadata
FROM session_events WHERE account_id=? AND tracking_session_id=?
ORDER BY occurred_at,(stream_id IS NOT NULL),stream_id,sequence_number,id LIMIT 200;
