import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/accounts.js';
import mysql from 'mysql2/promise';
import { getConfig } from '../src/config.js';
const config = getConfig();
const { database, connectionLimit: _limit, ...options } = config.db;
const connection = await mysql.createConnection(options);
try {
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  );
  await connection.changeUser({ database });
  await connection.query(`CREATE TABLE IF NOT EXISTS recordings (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    form_key VARCHAR(160) NOT NULL,
    form_id VARCHAR(160) NOT NULL,
    user_id VARCHAR(160) NULL,
    page_url VARCHAR(2048) NOT NULL,
    browser VARCHAR(1024) NOT NULL,
    duration_ms INT UNSIGNED NOT NULL,
    event_count INT UNSIGNED NOT NULL,
    field_count INT UNSIGNED NOT NULL,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    size_bytes INT UNSIGNED NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY unique_session_form (session_id, form_key),
    KEY created_at_index (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
  await connection.query(`CREATE TABLE IF NOT EXISTS accounts (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    name VARCHAR(160) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    company_origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await connection.query(`CREATE TABLE IF NOT EXISTS login_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    KEY session_expiry (expires_at)
  ) ENGINE=InnoDB`);
  const [columns] = await connection.query('SHOW COLUMNS FROM recordings');
  for (const [name, definition] of [
    ['account_id', 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL'],
    ['user_name', 'VARCHAR(160) NULL'],
    ['page_title', 'VARCHAR(300) NULL'],
    ['save_reason', 'VARCHAR(20) NULL'],
  ]) {
    if (!columns.some((column) => column.Field === name))
      await connection.query(`ALTER TABLE recordings ADD COLUMN ${name} ${definition}`);
  }
  const [indexes] = await connection.query('SHOW INDEX FROM recordings');
  if (!indexes.some((index) => index.Key_name === 'account_created'))
    await connection.query('CREATE INDEX account_created ON recordings (account_id, created_at)');
  const [accountColumns] = await connection.query('SHOW COLUMNS FROM accounts');
  if (!accountColumns.some((column) => column.Field === 'is_master'))
    await connection.query(
      'ALTER TABLE accounts ADD COLUMN is_master BOOLEAN NOT NULL DEFAULT FALSE',
    );
  if (accountColumns.find((column) => column.Field === 'company_origin').Null === 'NO')
    await connection.query(
      'ALTER TABLE accounts MODIFY company_origin VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL',
    );
  const [masters] = await connection.execute('SELECT id,is_master FROM accounts WHERE email=?', [
    'admin@admin.com',
  ]);
  if (!masters.length) {
    await connection.execute(
      'INSERT INTO accounts (id,name,email,password_hash,company_origin,is_master) VALUES (?,?,?,?,NULL,TRUE)',
      [randomUUID(), 'Master Admin', 'admin@admin.com', await hashPassword('admin@123')],
    );
  } else if (!masters[0].is_master) {
    throw new Error(
      'admin@admin.com already belongs to a company account; resolve this conflict before creating the master account.',
    );
  }
  const [integrationColumns] = await connection.query('SHOW COLUMNS FROM accounts');
  for (const [name, definition] of [
    ['verification_token', 'CHAR(64) NULL'],
    ['api_key_encrypted', 'TEXT NULL'],
    ['domain_verified_at', 'DATETIME NULL'],
    ['api_key_hash', 'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL'],
    ['key_version', 'INT UNSIGNED NOT NULL DEFAULT 0'],
  ]) {
    if (!integrationColumns.some((column) => column.Field === name))
      await connection.query(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`);
  }
  const [accountIndexes] = await connection.query('SHOW INDEX FROM accounts');
  if (!accountIndexes.some((index) => index.Key_name === 'unique_api_key_hash'))
    await connection.query('CREATE UNIQUE INDEX unique_api_key_hash ON accounts(api_key_hash)');
  await connection.query(
    'CREATE TABLE IF NOT EXISTS used_recording_grants (id CHAR(36) PRIMARY KEY, expires_at DATETIME NOT NULL, KEY grant_expiry(expires_at)) ENGINE=InnoDB',
  );
  console.info(`Database ${database} is ready.`);
} finally {
  await connection.end();
}
