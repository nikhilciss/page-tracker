import {
  attachReportFacts,
  reportSummary,
  recordingsForVisits,
  addVideoStatus,
} from './activity-reports.js';
// Read-only reporting over existing analytics and recording tables.
export function technical(ua = '') {
  if (!ua) return { browser: 'Unknown', device: 'Unknown', os: 'Unknown' };
  return {
    browser: /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /(?:Chrome|CriOS)\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Other',
    device:
      /iPad|Tablet/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
        ? 'Tablet'
        : /Mobile|iPhone/i.test(ua)
          ? 'Mobile'
          : 'Desktop',
    os: /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Macintosh|Mac OS/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Other',
  };
}
export function summarize(sessions, pages, counts, engagement, from) {
  const eventCounts = {},
    top = new Map(),
    visitors = new Map(),
    trends = new Map();
  const breakdown = { browser: {}, device: {}, os: {} };
  const engaged = new Map(engagement.map((r) => [r.tracking_session_id, Number(r.engaged_ms)]));
  const bySession = new Map(sessions.map((s) => [s.id, s]));
  for (const s of sessions) {
    s.pages = 0;
    s.interactions = 0;
    s.engaged_ms = engaged.get(s.id) || 0;
    s.observed_ms = Math.max(0, new Date(s.last_activity_at) - new Date(s.started_at));
    // Dashboard visitor count is session-based: repeat visits count separately.
    visitors.set(s.id, new Date(s.first_seen_at) >= new Date(from) ? 'new' : 'returning');
    for (const key of Object.keys(breakdown))
      breakdown[key][s[key]] = (breakdown[key][s[key]] || 0) + 1;
    const day = new Date(s.started_at).toISOString().slice(0, 10);
    const trend = trends.get(day) || { day, sessions: 0, engaged_ms: 0 };
    trend.sessions++;
    trend.engaged_ms += s.engaged_ms;
    trends.set(day, trend);
  }
  const milestones = [25, 50, 75, 90, 100].map((depth) => ({ depth, pages: 0 }));
  for (const p of pages) {
    bySession.get(p.tracking_session_id).pages += Number(p.views);
    const entry = top.get(p.page_url) || { url: p.page_url, views: 0, depth_sum: 0 };
    entry.views += Number(p.views);
    entry.depth_sum += Number(p.depth_sum);
    top.set(p.page_url, entry);
    for (const m of milestones) m.pages += Number(p['reach_' + m.depth]);
  }
  for (const c of counts) {
    eventCounts[c.event_type] = (eventCounts[c.event_type] || 0) + Number(c.total);
    if (
      [
        'click',
        'form_start',
        'form_field_interaction',
        'form_submit',
        'form_validation_attempt',
        'form_success',
      ].includes(c.event_type)
    )
      bySession.get(c.tracking_session_id).interactions += Number(c.total);
  }
  return {
    totals: {
      visitors: visitors.size,
      unique_identities: new Set(sessions.map((s) => s.visitor_id)).size,
      sessions: sessions.length,
      page_views: pages.reduce((n, p) => n + Number(p.views), 0),
      new_visitors: [...visitors.values()].filter((v) => v === 'new').length,
      returning_visitors: [...visitors.values()].filter((v) => v === 'returning').length,
      average_observed_ms: sessions.length
        ? sessions.reduce((n, s) => n + s.observed_ms, 0) / sessions.length
        : 0,
      average_engaged_ms: sessions.length
        ? sessions.reduce((n, s) => n + s.engaged_ms, 0) / sessions.length
        : 0,
      interactions: sessions.reduce((n, s) => n + s.interactions, 0),
    },
    trends: [...trends.values()].sort((a, b) => a.day.localeCompare(b.day)),
    top_pages: [...top.values()]
      .map((p) => ({ ...p, average_depth: p.depth_sum / p.views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10),
    milestones,
    events: eventCounts,
    breakdown,
  };
}
export function dashboardRepository(pool) {
  async function recordings(account, id) {
    const [rows] = await pool.execute(
      `SELECT DISTINCT r.id,r.session_id,r.browser,r.user_name,r.user_id,r.duration_ms,r.created_at,r.page_url FROM recordings r JOIN session_pages p ON p.recording_session_id=r.session_id AND p.account_id=r.account_id WHERE p.account_id=? AND p.tracking_session_id=? ORDER BY r.created_at,r.id`,
      [account, id],
    );
    return rows.map((row) => ({ ...row, technical: technical(row.browser) }));
  }
  async function aggregates(account, ids) {
    if (!ids.length) return { pages: [], counts: [], engagement: [] };
    const placeholders = ids.map(() => '?').join(',');
    const args = [account, ...ids];
    const [pages] = await pool.execute(
      `SELECT tracking_session_id,page_url,COUNT(*) views,SUM(max_scroll) depth_sum,${[25, 50, 75, 90, 100].map((n) => `SUM(max_scroll>=${n}) reach_${n}`).join(',')} FROM session_pages WHERE account_id=? AND tracking_session_id IN (${placeholders}) GROUP BY tracking_session_id,page_url`,
      args,
    );
    const [counts] = await pool.execute(
      `SELECT tracking_session_id,event_type,COUNT(*) total FROM session_events WHERE account_id=? AND tracking_session_id IN (${placeholders}) GROUP BY tracking_session_id,event_type`,
      args,
    );
    const [engagement] = await pool.execute(
      `WITH intervals AS (
      SELECT tracking_session_id,occurred_at finish_at,TIMESTAMPADD(MICROSECOND,-CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.engaged_ms')) AS SIGNED)*1000,occurred_at) begin_at
      FROM session_events WHERE account_id=? AND tracking_session_id IN (${placeholders}) AND event_type='engagement'
    ), previous_intervals AS (
      SELECT *,MAX(finish_at) OVER (PARTITION BY tracking_session_id ORDER BY begin_at,finish_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) previous_end FROM intervals
    ) SELECT tracking_session_id,SUM(GREATEST(0,TIMESTAMPDIFF(MICROSECOND,GREATEST(begin_at,COALESCE(previous_end,begin_at)),finish_at)))/1000 engaged_ms FROM previous_intervals GROUP BY tracking_session_id`,
      args,
    );
    return { pages, counts, engagement };
  }
  return {
    async overview(account, filters) {
      const [projects] = await pool.execute(
        'SELECT id,origin FROM projects WHERE account_id=? ORDER BY origin',
        [account],
      );
      const [rows] = await pool.execute(
        `SELECT s.*,v.first_seen_at,
        IF(s.ended_at IS NULL AND s.last_activity_at>TIMESTAMPADD(SECOND,-s.timeout_seconds,UTC_TIMESTAMP(3)),'active','timed_out') status,
        COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(c.context,'$.user_agent')) FROM recording_contexts c JOIN session_pages p ON p.account_id=c.account_id AND p.recording_session_id=c.recording_session_id WHERE p.account_id=s.account_id AND p.tracking_session_id=s.id ORDER BY c.captured_at LIMIT 1),
        (SELECT r.browser FROM session_pages p JOIN recordings r ON r.session_id=p.recording_session_id AND r.account_id=p.account_id WHERE p.account_id=s.account_id AND p.tracking_session_id=s.id ORDER BY r.created_at,r.id LIMIT 1)) user_agent,
        (SELECT NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(c.context,'$.user_name')),''),'null') FROM recording_contexts c JOIN session_pages p ON p.account_id=c.account_id AND p.recording_session_id=c.recording_session_id WHERE p.account_id=s.account_id AND p.tracking_session_id=s.id ORDER BY c.captured_at DESC,c.recording_session_id DESC LIMIT 1) visitor_label
        FROM tracking_sessions s JOIN visitors v ON v.id=s.visitor_id AND v.account_id=s.account_id
        WHERE s.account_id=? AND s.started_at>=? AND s.started_at<? ${filters.project ? 'AND s.project_id=?' : ''}
        ORDER BY s.started_at DESC,s.id DESC LIMIT 5001`,
        [account, filters.from, filters.to, ...(filters.project ? [filters.project] : [])],
      );
      if (rows.length > 5000)
        throw Object.assign(
          new Error(
            'More than 5,000 sessions match. Narrow the date range or project to view complete results.',
          ),
          { status: 422 },
        );
      const [historical] = await pool.execute(
        `SELECT r.id,r.session_id,r.page_url,r.browser,r.user_name,r.user_id,r.duration_ms,r.created_at,p.id project_id
         FROM recordings r LEFT JOIN projects p ON p.account_id=r.account_id AND p.origin=SUBSTRING_INDEX(r.page_url,'/',3)
         WHERE r.account_id=? AND r.created_at>=? AND r.created_at<?
         ${filters.project ? 'AND p.id=?' : ''}
         AND NOT EXISTS (SELECT 1 FROM session_pages sp WHERE sp.account_id=r.account_id AND sp.recording_session_id=r.session_id)
         ORDER BY r.created_at DESC,r.id DESC LIMIT 5001`,
        [account, filters.from, filters.to, ...(filters.project ? [filters.project] : [])],
      );
      if (historical.length + rows.length > 5000)
        throw Object.assign(
          new Error('More than 5,000 records match. Narrow the date range or project.'),
          { status: 422 },
        );
      const legacy = new Map();
      for (const r of historical) {
        const existing = legacy.get(r.session_id);
        if (existing) {
          existing.observed_ms = Math.max(existing.observed_ms, Number(r.duration_ms));
          existing.urls.add(r.page_url);
          continue;
        }
        legacy.set(r.session_id, {
          id: r.session_id,
          recording_id: r.id,
          source: 'recording',
          visitor_id: null,
          visitor_label: r.user_name || r.user_id || 'Unknown visitor',
          project_id: r.project_id,
          started_at: r.created_at,
          status: 'recorded',
          observed_ms: Number(r.duration_ms),
          engaged_ms: null,
          urls: new Set([r.page_url]),
          ...technical(r.browser),
        });
      }
      const all = rows.map((s) => ({ ...s, ...technical(s.user_agent) }));
      const available = [...all, ...legacy.values()];
      await attachReportFacts(pool, account, available);
      const matches = (s) =>
        (!filters.browser || s.browser === filters.browser) &&
        (!filters.device || s.device === filters.device) &&
        (!filters.country || s.country === filters.country) &&
        (!filters.ip || s.ip === filters.ip) &&
        (!filters.referrer || s.referrer === filters.referrer) &&
        (!filters.input_method ||
          (filters.input_method === 'unknown'
            ? !s.input_methods.size
            : s.input_methods.has(filters.input_method)));
      const options = {
        country: [...new Set(available.map((s) => s.country))].sort(),
        referrer: [...new Set(available.map((s) => s.referrer))].sort(),
        browser: [...new Set(available.map((s) => s.browser))].sort(),
        device: [...new Set(available.map((s) => s.device))].sort(),
      };
      const sessions = all.filter(matches);
      const a = await aggregates(
        account,
        sessions.map((s) => s.id),
      );
      const summary = summarize(sessions, a.pages, a.counts, a.engagement, filters.from);
      const recorded = [...legacy.values()]
        .filter(matches)
        .map(({ urls, ...s }) => ({ ...s, pages: urls.size }));
      for (const s of recorded) {
        for (const key of ['browser', 'device', 'os'])
          summary.breakdown[key][s[key]] = (summary.breakdown[key][s[key]] || 0) + 1;
        const day = new Date(s.started_at).toISOString().slice(0, 10);
        let trend = summary.trends.find((t) => t.day === day);
        if (!trend) {
          trend = { day, sessions: 0, engaged_ms: 0 };
          summary.trends.push(trend);
        }
        trend.sessions++;
      }
      summary.trends.sort((a, b) => a.day.localeCompare(b.day));
      summary.coverage = {
        analytics_sessions: sessions.length,
        historical_visits: recorded.length,
      };
      summary.totals.sessions += recorded.length;
      const combined = [...sessions, ...recorded].sort(
        (a, b) => new Date(b.started_at) - new Date(a.started_at) || b.id.localeCompare(a.id),
      );
      const report = reportSummary(combined, await recordingsForVisits(pool, account, combined));
      const publicVisit = ({
        context,
        documents,
        domains,
        input_methods,
        submit_times,
        field_activity,
        sensitive_activity,
        ...s
      }) => s;
      return {
        ...summary,
        reports: report,
        projects,
        options,
        sessions: combined.slice(filters.offset, filters.offset + 20).map(publicVisit),
        total: combined.length,
      };
    },
    async detail(account, id) {
      const a = await aggregates(account, [id]);
      return {
        recordings: await recordings(account, id),
        engaged_ms: Number(a.engagement[0]?.engaged_ms || 0),
        events: Object.fromEntries(a.counts.map((c) => [c.event_type, Number(c.total)])),
      };
    },
  };
}
export function dashboardRoutes({ app, repository, requireLogin, videos, pages }) {
  app.get('/api/admin/analytics', requireLogin, async (req, res) => {
    const {
      from,
      to,
      project = '',
      browser = '',
      device = '',
      country = '',
      ip = '',
      referrer = '',
      input_method = '',
    } = req.query;
    const offset = Number(req.query.offset || 0);
    if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      from >= to ||
      Date.parse(to) - Date.parse(from) > 366 * 86400000 ||
      typeof project !== 'string' ||
      (project && !/^[a-f0-9-]{36}$/i.test(project)) ||
      typeof browser !== 'string' ||
      browser.length > 30 ||
      [country, ip, referrer, input_method].some((v) => typeof v !== 'string' || v.length > 255) ||
      (input_method &&
        !['typing', 'paste', 'drop', 'replacement', 'selection', 'unknown'].includes(
          input_method,
        )) ||
      typeof device !== 'string' ||
      device.length > 30 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 5000
    )
      return res
        .status(400)
        .json({ error: 'Choose a valid date range of up to 366 days and valid filters.' });
    try {
      const result = await repository.dashboard.overview(req.account.id, {
        from,
        to,
        project,
        browser,
        device,
        country,
        ip,
        referrer,
        input_method,
        offset,
      });
      await addVideoStatus(result.reports, videos);
      res.json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });
  app.get('/api/admin/analytics/sessions/:id', requireLogin, async (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      return res.status(404).json({ error: 'Session not found' });
    const result = await repository.analytics.get(req.account.id, req.params.id);
    if (!result) return res.status(404).json({ error: 'Session not found' });
    res.json({
      ...result,
      pending_capture: await pages.pendingSummary(
        req.account.id,
        result.pages.map((p) => p.recording_session_id),
      ),
      ...(await repository.dashboard.detail(req.account.id, req.params.id)),
      contexts: (await repository.context?.session(req.account.id, req.params.id)) || [],
    });
  });
}
