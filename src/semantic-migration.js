export async function migrateSemantic(c) {
  const id = 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin';
  const [columns] = await c.query('SHOW COLUMNS FROM session_pages');
  for (const [name, type] of [
    ['view_key', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['engaged_ms', 'BIGINT UNSIGNED NOT NULL DEFAULT 0'],
    ['max_scroll', 'DECIMAL(5,2) NOT NULL DEFAULT 0'],
    ['observed_ms', 'BIGINT UNSIGNED NOT NULL DEFAULT 0'],
  ])
    if (!columns.some((x) => x.Field === name))
      await c.query(`ALTER TABLE session_pages ADD COLUMN ${name} ${type}`);
  const [indexes] = await c.query('SHOW INDEX FROM session_pages');
  if (!indexes.some((x) => x.Key_name === 'page_view_recording'))
    await c.query(
      'ALTER TABLE session_pages ADD UNIQUE KEY page_view_recording(account_id,recording_session_id,view_key)',
    );
  if (indexes.some((x) => x.Key_name === 'page_recording'))
    await c.query('ALTER TABLE session_pages DROP INDEX page_recording');
  if (!indexes.some((x) => x.Key_name === 'page_owner'))
    await c.query(
      'ALTER TABLE session_pages ADD UNIQUE KEY page_owner(account_id,project_id,tracking_session_id,id)',
    );
  await c.query(`CREATE TABLE IF NOT EXISTS semantic_streams (
 id ${id} PRIMARY KEY, account_id ${id} NOT NULL,project_id ${id} NOT NULL,visitor_id ${id} NOT NULL,
 session_id ${id} NOT NULL,page_id ${id} NOT NULL,next_sequence INT UNSIGNED NOT NULL DEFAULT 0,
 last_offset_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,started_at DATETIME(3) NOT NULL,
 UNIQUE KEY stream_owner(account_id,project_id,id),
 FOREIGN KEY(account_id,project_id,visitor_id) REFERENCES visitors(account_id,project_id,id),
 FOREIGN KEY(account_id,project_id,session_id,page_id) REFERENCES session_pages(account_id,project_id,tracking_session_id,id)
 ) ENGINE=InnoDB`);
  const [streamColumns] = await c.query('SHOW COLUMNS FROM semantic_streams');
  if (!streamColumns.some((x) => x.Field === 'last_engagement_offset_ms'))
    await c.query(
      'ALTER TABLE semantic_streams ADD COLUMN last_engagement_offset_ms BIGINT UNSIGNED NOT NULL DEFAULT 0',
    );
  await c.query(`CREATE TABLE IF NOT EXISTS session_events (
 id ${id} PRIMARY KEY,account_id ${id} NOT NULL,project_id ${id} NOT NULL,visitor_id ${id} NOT NULL,
 tracking_session_id ${id} NOT NULL,page_id ${id} NOT NULL,stream_id ${id} NULL,
 sequence_number INT UNSIGNED NULL,event_type VARCHAR(40) NOT NULL,occurred_at DATETIME(3) NOT NULL,
 page_offset_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,session_offset_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
 recording_offset_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,metadata JSON NOT NULL,payload_hash CHAR(64) NULL,
 UNIQUE KEY stream_sequence(stream_id,sequence_number),KEY event_time(project_id,tracking_session_id,occurred_at),
 KEY event_reporting(project_id,event_type,occurred_at),
 FOREIGN KEY(account_id,project_id,visitor_id) REFERENCES visitors(account_id,project_id,id),
 FOREIGN KEY(account_id,project_id,tracking_session_id,page_id) REFERENCES session_pages(account_id,project_id,tracking_session_id,id),
 FOREIGN KEY(account_id,project_id,stream_id) REFERENCES semantic_streams(account_id,project_id,id)
 ) ENGINE=InnoDB`);
}
