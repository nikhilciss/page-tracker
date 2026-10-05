import mysql from 'mysql2/promise';

export function createRepository(config) {
  const pool = mysql.createPool(config.db);
  return {
    pool,
    async integration(id) {
      const [rows] = await pool.execute(
        'SELECT domain_verified_at,key_version FROM accounts WHERE id=?',
        [id],
      );
      return rows[0];
    },
    async createAccount(user) {
      await pool.execute(
        'INSERT INTO accounts (id,name,email,password_hash,company_origin,domain_verified_at) VALUES (?,?,?,?,?,?)',
        [
          user.id,
          user.name,
          user.email,
          user.password_hash,
          user.company_origin,
          user.domain_verified_at,
        ],
      );
    },
    async accountByEmail(email) {
      const [rows] = await pool.execute('SELECT * FROM accounts WHERE email = ?', [email]);
      return rows[0];
    },
    async ownerByOrigin(origin) {
      const [rows] = await pool.execute(
        'SELECT id,key_version FROM accounts WHERE company_origin = ? AND is_master = FALSE AND domain_verified_at IS NOT NULL',
        [origin],
      );
      return rows[0];
    },
    async accountById(id) {
      const [rows] = await pool.execute(
        'SELECT id,name,email,company_origin,is_master,created_at FROM accounts WHERE id=?',
        [id],
      );
      return rows[0];
    },
    async companies(limit, offset) {
      const [rows] = await pool.query(
        'SELECT a.id,a.name,a.email,a.company_origin,a.created_at,(SELECT COUNT(*) FROM recordings r WHERE r.account_id=a.id) AS session_count FROM accounts a WHERE a.is_master=FALSE ORDER BY a.created_at DESC,a.id LIMIT ? OFFSET ?',
        [limit, offset],
      );
      const [[stats]] = await pool.query(
        'SELECT COUNT(*) AS total FROM accounts WHERE is_master=FALSE',
      );
      return { companies: rows, total: stats.total };
    },
    async createLoginSession(hash, accountId, expiry) {
      await pool.execute('DELETE FROM login_sessions WHERE expires_at <= UTC_TIMESTAMP()', []);
      await pool.execute(
        'INSERT INTO login_sessions (token_hash,account_id,expires_at) VALUES (?,?,?)',
        [hash, accountId, expiry],
      );
    },
    async loginSession(hash) {
      const [rows] = await pool.execute(
        'SELECT a.id,a.name,a.email,a.company_origin,a.is_master FROM login_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at > UTC_TIMESTAMP()',
        [hash],
      );
      return rows[0];
    },
    async deleteLoginSession(hash) {
      await pool.execute('DELETE FROM login_sessions WHERE token_hash=?', [hash]);
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async insert(row) {
      await pool.execute(
        `INSERT INTO recordings
        (id, session_id, form_key, form_id, user_id, page_url, browser, duration_ms, event_count, field_count, truncated, size_bytes, account_id, user_name, page_title, save_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.session_id,
          row.form_key,
          row.form_id,
          row.user_id,
          row.page_url,
          row.browser,
          row.duration_ms,
          row.event_count,
          row.field_count,
          row.truncated,
          row.size_bytes,
          row.account_id || null,
          row.user_name || null,
          row.page_title || null,
          row.save_reason || null,
        ],
      );
    },
    async findSession(sessionId, formKey) {
      const [rows] = await pool.execute(
        'SELECT * FROM recordings WHERE session_id = ? AND form_key = ?',
        [sessionId, formKey],
      );
      return rows[0];
    },
    async get(id) {
      const [rows] = await pool.execute('SELECT * FROM recordings WHERE id = ?', [id]);
      return rows[0];
    },
    async list(limit, offset, accountId) {
      const [rows] = await pool.query(
        'SELECT * FROM recordings WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        [accountId, limit, offset],
      );
      const [[stats]] = await pool.query(
        `SELECT COUNT(*) AS total, COALESCE(SUM(user_id IS NULL), 0) AS guests,
        COALESCE(AVG(duration_ms), 0) AS average_duration_ms, COALESCE(SUM(size_bytes), 0) AS storage_bytes FROM recordings WHERE account_id = ?`,
        [accountId],
      );
      return { recordings: rows, stats };
    },
    async expired(days) {
      const [rows] = await pool.execute(
        'SELECT id FROM recordings WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) LIMIT 1000',
        [days],
      );
      return rows;
    },
    async remove(id) {
      await pool.execute('DELETE FROM recordings WHERE id = ?', [id]);
    },
    async close() {
      await pool.end();
    },
  };
}
