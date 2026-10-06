import { randomUUID } from 'node:crypto';
export function analyticsRepository(pool) {
  return {
    async start({ account, origin, visitor, recording, url, timeout }) {
      const c = await pool.getConnection();
      try {
        await c.beginTransaction();
        await c.execute('INSERT IGNORE INTO projects(id,account_id,origin) VALUES (?,?,?)', [
          randomUUID(),
          account,
          origin,
        ]);
        const [[project]] = await c.execute(
          'SELECT * FROM projects WHERE account_id=? AND origin=? FOR UPDATE',
          [account, origin],
        );
        const [[existing]] = await c.execute(
          'SELECT p.id AS page_id,p.tracking_session_id AS session_id,s.visitor_id,s.timeout_seconds FROM session_pages p JOIN tracking_sessions s ON s.id=p.tracking_session_id WHERE p.account_id=? AND p.recording_session_id=? ORDER BY p.started_at,p.id LIMIT 1',
          [account, recording],
        );
        if (existing) {
          await c.commit();
          return existing;
        }
        await c.execute(
          'INSERT IGNORE INTO visitors(id,account_id,project_id,first_seen_at,last_seen_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
          [visitor, account, project.id],
        );
        const [[owner]] = await c.execute(
          'SELECT id FROM visitors WHERE account_id=? AND project_id=? AND id=? FOR UPDATE',
          [account, project.id, visitor],
        );
        if (!owner) throw new Error('Visitor ownership mismatch');
        const [[previous]] = await c.execute(
          'SELECT *,last_activity_at > TIMESTAMPADD(SECOND,-timeout_seconds,UTC_TIMESTAMP(3)) AS active FROM tracking_sessions WHERE account_id=? AND project_id=? AND visitor_id=? ORDER BY last_activity_at DESC LIMIT 1 FOR UPDATE',
          [account, project.id, visitor],
        );
        let session = previous?.active && !previous.ended_at ? previous.id : null;
        const seconds = Math.max(
          60,
          Math.min(86400, project.inactivity_timeout_seconds || timeout),
        );
        if (!session) {
          if (previous && !previous.ended_at)
            await c.execute(
              'UPDATE tracking_sessions SET ended_at=last_activity_at WHERE id=? AND account_id=?',
              [previous.id, account],
            );
          session = randomUUID();
          await c.execute(
            'INSERT INTO tracking_sessions(id,account_id,project_id,visitor_id,started_at,last_activity_at,timeout_seconds,returning_visitor) VALUES (?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),?,?)',
            [session, account, project.id, visitor, seconds, !!previous],
          );
        }
        const page = randomUUID();
        await c.execute(
          'INSERT INTO session_pages(id,account_id,project_id,tracking_session_id,recording_session_id,page_url,started_at,last_activity_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
          [page, account, project.id, session, recording, url],
        );
        await c.execute(
          'UPDATE visitors SET last_seen_at=UTC_TIMESTAMP(3) WHERE id=? AND account_id=?',
          [visitor, account],
        );
        await c.execute(
          'UPDATE tracking_sessions SET last_activity_at=UTC_TIMESTAMP(3) WHERE id=? AND account_id=?',
          [session, account],
        );
        await c.commit();
        return {
          page_id: page,
          session_id: session,
          visitor_id: visitor,
          timeout_seconds: previous?.active ? previous.timeout_seconds : seconds,
        };
      } catch (error) {
        await c.rollback();
        throw error;
      } finally {
        c.release();
      }
    },
    async activity(account, recording) {
      const [r] = await pool.execute(
        `UPDATE session_pages p JOIN tracking_sessions s ON s.id=p.tracking_session_id
        JOIN visitors v ON v.id=s.visitor_id SET p.last_activity_at=UTC_TIMESTAMP(3),
        s.last_activity_at=UTC_TIMESTAMP(3),v.last_seen_at=UTC_TIMESTAMP(3)
        WHERE p.account_id=? AND p.recording_session_id=? AND s.ended_at IS NULL
        AND s.last_activity_at > TIMESTAMPADD(SECOND,-s.timeout_seconds,UTC_TIMESTAMP(3))`,
        [account, recording],
      );
      return r.affectedRows > 0;
    },
    async get(account, id) {
      const [[session]] = await pool.execute(
        `SELECT *,IF(ended_at IS NULL AND
        last_activity_at > TIMESTAMPADD(SECOND,-timeout_seconds,UTC_TIMESTAMP(3)),
        'active','timed_out') AS status FROM tracking_sessions WHERE account_id=? AND id=?`,
        [account, id],
      );
      if (!session) return null;
      const [pages] = await pool.execute(
        'SELECT * FROM session_pages WHERE account_id=? AND tracking_session_id=? ORDER BY started_at,id',
        [account, id],
      );
      return { session, pages };
    },
  };
}
