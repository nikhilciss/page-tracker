// Additive foundation. Existing tables and historical recordings are never rewritten.
export async function migrateAnalytics(connection) {
  const id = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';
  await connection.query(`CREATE TABLE IF NOT EXISTS projects (
    id ${id} PRIMARY KEY, account_id ${id} NOT NULL,
    origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    inactivity_timeout_seconds INT UNSIGNED NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY project_owner (account_id,id), UNIQUE KEY project_origin (account_id,origin),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE IF NOT EXISTS visitors (
    id ${id} PRIMARY KEY, account_id ${id} NOT NULL, project_id ${id} NOT NULL,
    first_seen_at DATETIME(3) NOT NULL, last_seen_at DATETIME(3) NOT NULL,
    UNIQUE KEY visitor_owner (account_id,project_id,id),
    KEY visitor_seen (project_id,first_seen_at),
    FOREIGN KEY (account_id,project_id) REFERENCES projects(account_id,id)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE IF NOT EXISTS tracking_sessions (
    id ${id} PRIMARY KEY, account_id ${id} NOT NULL, project_id ${id} NOT NULL,
    visitor_id ${id} NOT NULL, started_at DATETIME(3) NOT NULL,
    last_activity_at DATETIME(3) NOT NULL, ended_at DATETIME(3) NULL,
    timeout_seconds INT UNSIGNED NOT NULL, returning_visitor BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE KEY tracking_owner (account_id,project_id,id),
    KEY sessions_visitor (project_id,visitor_id,last_activity_at),
    KEY sessions_started (project_id,started_at,id),
    FOREIGN KEY (account_id,project_id,visitor_id) REFERENCES visitors(account_id,project_id,id)
  ) ENGINE=InnoDB`);
  await connection.query(`CREATE TABLE IF NOT EXISTS session_pages (
    id ${id} PRIMARY KEY, account_id ${id} NOT NULL, project_id ${id} NOT NULL,
    tracking_session_id ${id} NOT NULL, recording_session_id ${id} NOT NULL,
    page_url VARCHAR(2048) NOT NULL, started_at DATETIME(3) NOT NULL,
    last_activity_at DATETIME(3) NOT NULL,
    UNIQUE KEY page_recording (account_id,recording_session_id),
    KEY pages_session (project_id,tracking_session_id,started_at),
    FOREIGN KEY (account_id,project_id,tracking_session_id)
      REFERENCES tracking_sessions(account_id,project_id,id)
  ) ENGINE=InnoDB`);
  await connection.query(`INSERT IGNORE INTO projects(id,account_id,origin)
    SELECT UUID(),id,company_origin FROM accounts WHERE is_master=FALSE AND company_origin IS NOT NULL`);
}
