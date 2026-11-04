const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { loadAuthConfig } = require('../scripts/start-with-auth.cjs');
test('只读认证配置仅接受允许字段，不执行配置内容；不安全权限或重复字段拒绝启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-config-')), file = join(dir, 'auth.env');
  try {
    const env = { UNRELATED: 'preserved' };
    loadAuthConfig(file, env);
    writeFileSync(file, 'WEB_SESSION_ENABLED=true\nAUTH_ORIGIN=https://example.test\nAUTH_CSRF_SECRET=$(must-not-execute)\n', { mode: 0o600 });
    loadAuthConfig(file, env);
    assert.equal(env.AUTH_CSRF_SECRET, '$(must-not-execute)');
    assert.equal(env.UNRELATED, 'preserved');
    chmodSync(file, 0o644); assert.throws(() => loadAuthConfig(file, env), /私有/);
    chmodSync(file, 0o600);
    writeFileSync(file, 'NODE_OPTIONS=bad\n'); assert.throws(() => loadAuthConfig(file, env), /不支持/);
    writeFileSync(file, 'AUTH_ORIGIN=a\nAUTH_ORIGIN=b\n'); assert.throws(() => loadAuthConfig(file, env), /重复/);
  } finally { rmSync(dir, { recursive: true }); }
});
