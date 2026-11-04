// CI 专用真实 MySQL 检查：强制使用 auth_session_test 数据库，不接收生产数据库名。
require('reflect-metadata');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { randomUUID, randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const bcrypt = require('bcrypt');
const { User } = require('../dist/users/users.entity.js');
const { UsersService } = require('../dist/users/users.service.js');
const { BrowserSession, UserAppGrant } = require('../dist/auth/browser-session.entity.js');
const { BrowserSessionsService } = require('../dist/auth/browser-sessions.service.js');
(async () => {
  const options = {
    host: '127.0.0.1',
    port: Number(process.env.AUTH_TEST_MYSQL_PORT || 3306),
    user: 'root',
    password: process.env.AUTH_TEST_MYSQL_PASSWORD || 'integration-only',
    database: 'auth_session_test',
  };
  const sql = await mysql.createConnection({ ...options, multipleStatements: true });
  let database;
  const deadline = setTimeout(() => { console.error("MySQL 隔离检查超时"); process.exit(1); }, 60_000);
  try {
    await sql.query(
      `CREATE TABLE users (id VARCHAR(36) PRIMARY KEY,email VARCHAR(100) NOT NULL UNIQUE,username VARCHAR(50) NOT NULL UNIQUE,password VARCHAR(255) NOT NULL,role ENUM('user','admin') NOT NULL DEFAULT 'user',created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    await sql.execute('INSERT INTO users(id,email,username,password) VALUES(?,?,?,?)', [
      randomUUID(),
      'fixture@example.invalid',
      'tuanzi',
      await bcrypt.hash('integration-only', 10),
    ]);
    await sql.query(await readFile('docs/plans/2026-11-04-browser-sessions.sql', 'utf8'));
    console.log('MySQL DDL applied to isolated test database.');
    database = new DataSource({
      host: options.host, port: options.port, username: options.user,
      password: options.password, database: options.database,
      type: 'mysql',
      entities: [User, BrowserSession, UserAppGrant],
      synchronize: false,
    });
    await database.initialize();
    console.log("ORM connection initialized.");
    const service = new BrowserSessionsService(
      database.getRepository(BrowserSession),
      database.getRepository(UserAppGrant),
      new UsersService(database.getRepository(User)),
      database,
      new ConfigService({
        WEB_SESSION_ENABLED: 'true',
        AUTH_ORIGIN: 'https://example.test',
        AUTH_CSRF_SECRET: randomBytes(32).toString('hex'),
      }),
    );
    let token;
    const request = {
      method: 'POST',
      headers: { origin: 'https://example.test', 'x-tuanzi-csrf': 'login' },
      socket: { remoteAddress: '127.0.0.1' },
      get: () => 'isolated CI browser',
      is: () => true,
    };
    const view = await service.create(
      { login: 'tuanzi', password: 'integration-only', remember: true },
      request,
      {
        cookie: (_name, value) => {
          token = value;
        },
      },
    );
    assert.ok(view.apps.includes('dsh'));
    assert.equal(Object.hasOwn(view.user, 'password'), false);
    const read = { method: 'GET', headers: { cookie: `__Host-tuanzi_session=${token}` } };
    const { session } = await service.authenticate(read);
    assert.equal((await service.list(session)).items.length, 1);
    assert.equal(
      (await database.getRepository(BrowserSession).findOneByOrFail({ id: session.id })).tokenHash,
      undefined,
    );
    await assert.rejects(
      service.authenticate({
        ...read,
        method: 'POST',
        headers: { ...read.headers, origin: 'https://example.test', 'x-tuanzi-csrf': 'wrong' },
      }),
      (e) => e.status === 403,
    );
    await service.authenticate({
      ...read,
      method: 'POST',
      headers: { ...read.headers, origin: 'https://example.test', 'x-tuanzi-csrf': view.csrfToken },
    });
    await service.revokeAll(session);
    await assert.rejects(service.authenticate(read), (e) => e.status === 401);
    console.log(
      'MySQL migration, ORM mapping, tuanzi-only grant, CSRF, hidden token hash and global revocation passed.',
    );
  } finally {
    clearTimeout(deadline);
    try { if (database?.isInitialized) await database.destroy(); }
    finally { await sql.end(); }
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
