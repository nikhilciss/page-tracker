import { randomUUID, createHash } from 'node:crypto';
import { safeSemanticMetadata } from './semantic-schema.js';
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const activityTypes = new Set([
  'page_view',
  'navigation',
  'click',
  'scroll_milestone',
  'form_start',
  'form_field_interaction',
  'form_submit',
  'form_validation_attempt',
  'form_success',
]);
export function semanticRepository(pool) {
  async function serverEvent(c, type, stream, time, metadata = {}) {
    const [[bounds]] = await c.execute(
      'SELECT p.started_at AS page_start,s.started_at AS session_start FROM session_pages p JOIN tracking_sessions s ON s.id=p.tracking_session_id WHERE p.account_id=? AND p.id=?',
      [stream.account_id, stream.page_id],
    );
    const millis = new Date(time).getTime();
    await c.execute(
      'INSERT INTO session_events(id,account_id,project_id,visitor_id,tracking_session_id,page_id,event_type,occurred_at,metadata,sequence_number,page_offset_ms,session_offset_ms,recording_offset_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        randomUUID(),
        stream.account_id,
        stream.project_id,
        stream.visitor_id,
        stream.session_id,
        stream.page_id,
        type,
        time,
        JSON.stringify({ ...metadata, source: 'server' }),
        type === 'session_start' ? 0 : 1,
        Math.max(0, millis - new Date(bounds.page_start).getTime()),
        Math.max(0, millis - new Date(bounds.session_start).getTime()),
        stream.started_at ? Math.max(0, millis - new Date(stream.started_at).getTime()) : 0,
      ],
    );
  }
  return {
    async ingest(claims, events) {
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        const [[project]] = await c.execute(
          'SELECT * FROM projects WHERE account_id=? AND origin=? FOR UPDATE',
          [claims.account_id, claims.origin],
        );
        if (!project) throw fail('Initialize analytics first');
        const [[initial]] = await c.execute(
          'SELECT p.*,s.visitor_id FROM session_pages p JOIN tracking_sessions s ON s.id=p.tracking_session_id WHERE p.account_id=? AND p.recording_session_id=? ORDER BY p.view_key LIMIT 1',
          [claims.account_id, claims.id],
        );
        if (!initial) throw fail('Initialize analytics first');
        await c.execute('SELECT id FROM visitors WHERE account_id=? AND id=? FOR UPDATE', [
          claims.account_id,
          initial.visitor_id,
        ]);
        await c.execute(
          'INSERT IGNORE INTO semantic_streams(id,account_id,project_id,visitor_id,session_id,page_id,started_at) VALUES (?,?,?,?,?,?,?)',
          [
            claims.id,
            claims.account_id,
            project.id,
            initial.visitor_id,
            initial.tracking_session_id,
            initial.id,
            initial.started_at,
          ],
        );
        const [[stream]] = await c.execute(
          'SELECT * FROM semantic_streams WHERE id=? AND account_id=? FOR UPDATE',
          [claims.id, claims.account_id],
        );
        if (stream.next_sequence === 0 && events[0]?.timestamp_ms !== undefined) {
          const epoch = events[0].timestamp_ms - events[0].offset_ms;
          if (epoch < Date.now() - 86400000 || epoch > Date.now() + 5000)
            throw fail('Invalid document clock', 400);
          stream.started_at = new Date(epoch);
          await c.execute(
            'UPDATE session_pages SET started_at=LEAST(started_at,?) WHERE id=? AND account_id=?',
            [stream.started_at, stream.page_id, claims.account_id],
          );
          await c.execute(
            'UPDATE tracking_sessions SET started_at=LEAST(started_at,?) WHERE id=? AND account_id=?',
            [stream.started_at, stream.session_id, claims.account_id],
          );
          await c.execute(
            'UPDATE visitors SET first_seen_at=LEAST(first_seen_at,?) WHERE id=? AND account_id=?',
            [stream.started_at, stream.visitor_id, claims.account_id],
          );
          await c.execute(
            "UPDATE session_events SET occurred_at=LEAST(occurred_at,?) WHERE tracking_session_id=? AND account_id=? AND event_type='session_start'",
            [stream.started_at, stream.session_id, claims.account_id],
          );

          await c.execute('UPDATE semantic_streams SET started_at=? WHERE id=? AND account_id=?', [
            stream.started_at,
            stream.id,
            claims.account_id,
          ]);
        }
        let [[session]] = await c.execute(
          'SELECT * FROM tracking_sessions WHERE id=? AND account_id=? FOR UPDATE',
          [stream.session_id, claims.account_id],
        );
        let [[page]] = await c.execute('SELECT * FROM session_pages WHERE id=? AND account_id=?', [
          stream.page_id,
          claims.account_id,
        ]);
        const [[seen]] = await c.execute(
          "SELECT id FROM session_events WHERE account_id=? AND tracking_session_id=? AND event_type='session_start' LIMIT 1",
          [claims.account_id, session.id],
        );
        if (!seen) await serverEvent(c, 'session_start', stream, session.started_at);
        for (const event of events) {
          const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
          if (event.sequence < stream.next_sequence) {
            const [[old]] = await c.execute(
              'SELECT id,payload_hash FROM session_events WHERE stream_id=? AND sequence_number=? AND account_id=?',
              [stream.id, event.sequence, claims.account_id],
            );
            if (!old || old.id !== event.id || old.payload_hash !== hash)
              throw fail('Conflicting event retry');
            continue;
          }
          if (event.sequence !== stream.next_sequence)
            throw Object.assign(fail('Sequence gap'), { expected_sequence: stream.next_sequence });
          if (event.offset_ms < stream.last_offset_ms) throw fail('Non-monotonic event time', 400);
          const time = new Date(new Date(stream.started_at).getTime() + event.offset_ms);
          if (time.getTime() > Date.now() + 5000) throw fail('Future event time', 400);
          const data = safeSemanticMetadata(event.metadata, claims.origin);
          const isActivity =
            activityTypes.has(event.type) || (event.type === 'engagement' && data.engaged_ms > 0);
          if (
            isActivity &&
            time - new Date(session.last_activity_at) >= session.timeout_seconds * 1000
          ) {
            const [[ended]] = await c.execute(
              "SELECT id FROM session_events WHERE account_id=? AND tracking_session_id=? AND event_type='inferred_timeout' LIMIT 1",
              [claims.account_id, session.id],
            );
            if (!ended)
              await serverEvent(c, 'inferred_timeout', stream, session.last_activity_at, {
                inferred: true,
              });
            await c.execute(
              'UPDATE tracking_sessions SET ended_at=last_activity_at WHERE id=? AND account_id=?',
              [session.id, claims.account_id],
            );
            // Another tab may already have opened the next session. Reuse it when the event fits.
            const [[active]] = await c.execute(
              'SELECT * FROM tracking_sessions WHERE account_id=? AND project_id=? AND visitor_id=? AND ended_at IS NULL AND started_at<=? AND last_activity_at>=? ORDER BY started_at DESC LIMIT 1 FOR UPDATE',
              [
                claims.account_id,
                project.id,
                stream.visitor_id,
                time,
                new Date(time.getTime() - session.timeout_seconds * 1000),
              ],
            );
            if (active) session = active;
            else {
              session = {
                id: randomUUID(),
                started_at: time,
                last_activity_at: time,
                timeout_seconds: Math.max(
                  60,
                  Math.min(86400, project.inactivity_timeout_seconds || session.timeout_seconds),
                ),
              };
              await c.execute(
                'INSERT INTO tracking_sessions(id,account_id,project_id,visitor_id,started_at,last_activity_at,timeout_seconds,returning_visitor) VALUES (?,?,?,?,?,?,?,TRUE)',
                [
                  session.id,
                  claims.account_id,
                  project.id,
                  stream.visitor_id,
                  time,
                  time,
                  session.timeout_seconds,
                ],
              );
            }
            stream.session_id = session.id;
          }
          const newUrl = event.type === 'page_view' && data.url ? data.url : page.page_url;
          if (new URL(newUrl).origin !== claims.origin) throw fail('Page origin mismatch', 400);
          if (
            stream.session_id !== page.tracking_session_id ||
            (event.type === 'page_view' && event.sequence > 0)
          ) {
            page = {
              id: randomUUID(),
              page_url: newUrl,
              started_at: time,
              tracking_session_id: stream.session_id,
            };
            stream.page_id = page.id;
            await c.execute(
              'INSERT INTO session_pages(id,account_id,project_id,tracking_session_id,recording_session_id,page_url,started_at,last_activity_at,view_key) VALUES (?,?,?,?,?,?,?,?,?)',
              [
                page.id,
                claims.account_id,
                project.id,
                stream.session_id,
                claims.id,
                newUrl,
                time,
                time,
                event.sequence + 1,
              ],
            );
            const [[exists]] = await c.execute(
              "SELECT id FROM session_events WHERE account_id=? AND tracking_session_id=? AND event_type='session_start' LIMIT 1",
              [claims.account_id, session.id],
            );
            if (!exists) await serverEvent(c, 'session_start', stream, session.started_at);
          }
          const engaged =
            event.type === 'engagement'
              ? Math.min(data.engaged_ms || 0, event.offset_ms - stream.last_engagement_offset_ms)
              : 0;
          if (event.type === 'engagement') {
            data.engaged_ms = engaged;
            stream.last_engagement_offset_ms = event.offset_ms;
          }
          await c.execute(
            `INSERT INTO session_events(id,account_id,project_id,visitor_id,tracking_session_id,page_id,stream_id,sequence_number,event_type,occurred_at,page_offset_ms,session_offset_ms,recording_offset_ms,metadata,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              event.id,
              claims.account_id,
              project.id,
              stream.visitor_id,
              session.id,
              page.id,
              stream.id,
              event.sequence,
              event.type,
              time,
              Math.max(0, time - new Date(page.started_at)),
              Math.max(0, time - new Date(session.started_at)),
              event.offset_ms,
              JSON.stringify(data),
              hash,
            ],
          );
          await c.execute(
            'UPDATE session_pages SET last_activity_at=GREATEST(last_activity_at,?),observed_ms=GREATEST(observed_ms,?),max_scroll=GREATEST(max_scroll,?),engaged_ms=engaged_ms+? WHERE id=? AND account_id=?',
            [
              time,
              Math.max(0, time - new Date(page.started_at)),
              data.depth || data.milestone || 0,
              engaged,
              page.id,
              claims.account_id,
            ],
          );
          if (isActivity) {
            if (session.ended_at && time > new Date(session.last_activity_at)) {
              await c.execute(
                'UPDATE tracking_sessions SET ended_at=? WHERE id=? AND account_id=?',
                [time, session.id, claims.account_id],
              );
              await c.execute(
                "UPDATE session_events SET occurred_at=? WHERE tracking_session_id=? AND account_id=? AND event_type='inferred_timeout'",
                [time, session.id, claims.account_id],
              );
            }
            await c.execute(
              'UPDATE tracking_sessions SET last_activity_at=GREATEST(last_activity_at,?) WHERE id=? AND account_id=?',
              [time, session.id, claims.account_id],
            );
            await c.execute(
              'UPDATE visitors SET last_seen_at=GREATEST(last_seen_at,?) WHERE id=? AND account_id=?',
              [time, stream.visitor_id, claims.account_id],
            );
            if (time > new Date(session.last_activity_at)) session.last_activity_at = time;
          }
          stream.next_sequence++;
          stream.last_offset_ms = event.offset_ms;
        }
        await c.execute(
          'UPDATE semantic_streams SET next_sequence=?,last_offset_ms=?,session_id=?,page_id=?,last_engagement_offset_ms=? WHERE id=? AND account_id=?',
          [
            stream.next_sequence,
            stream.last_offset_ms,
            stream.session_id,
            stream.page_id,
            stream.last_engagement_offset_ms,
            stream.id,
            claims.account_id,
          ],
        );
        await c.commit();
        return {
          next_sequence: stream.next_sequence,
          session_id: stream.session_id,
          page_id: stream.page_id,
        };
      } catch (e) {
        await c.rollback();
        if (e.code === 'ER_DUP_ENTRY') throw fail('Conflicting event ID');
        throw e;
      } finally {
        c.release();
      }
    },
    async expire(account) {
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        await c.execute('SELECT id FROM projects WHERE account_id=? FOR UPDATE', [account]);
        const [sessions] = await c.execute(
          'SELECT * FROM tracking_sessions WHERE account_id=? AND ended_at IS NULL AND last_activity_at<=TIMESTAMPADD(SECOND,-timeout_seconds,UTC_TIMESTAMP(3)) LIMIT 100 FOR UPDATE',
          [account],
        );
        for (const s of sessions) {
          const [[page]] = await c.execute(
            'SELECT id FROM session_pages WHERE account_id=? AND tracking_session_id=? ORDER BY started_at DESC LIMIT 1',
            [account, s.id],
          );
          if (page)
            await serverEvent(
              c,
              'inferred_timeout',
              {
                account_id: account,
                project_id: s.project_id,
                visitor_id: s.visitor_id,
                session_id: s.id,
                page_id: page.id,
              },
              s.last_activity_at,
              { inferred: true },
            );
          await c.execute(
            'UPDATE tracking_sessions SET ended_at=last_activity_at WHERE account_id=? AND id=?',
            [account, s.id],
          );
        }
        await c.commit();
      } catch (error) {
        await c.rollback();
        throw error;
      } finally {
        c.release();
      }
    },
    async events(account, session, after = 0) {
      const [[owned]] = await pool.execute(
        'SELECT id FROM tracking_sessions WHERE id=? AND account_id=?',
        [session, account],
      );
      if (!owned) return null;
      const [rows] = await pool.query(
        'SELECT id,project_id,visitor_id,tracking_session_id,page_id,event_type,occurred_at,sequence_number,page_offset_ms,session_offset_ms,recording_offset_ms,metadata FROM session_events WHERE account_id=? AND tracking_session_id=? ORDER BY occurred_at,(stream_id IS NOT NULL),stream_id,sequence_number,id LIMIT 200 OFFSET ?',
        [account, session, after],
      );
      return rows;
    },
  };
}
