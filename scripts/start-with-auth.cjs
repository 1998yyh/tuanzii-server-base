// 由应用进程读取只读挂载的 root 配置；宿主机发布账号无需读取认证密钥。
const { readFileSync, statSync } = require('node:fs');
const keys = new Set(['WEB_SESSION_ENABLED', 'AUTH_ORIGIN', 'AUTH_CSRF_SECRET', 'LEGACY_JWT_ENABLED']);
function loadAuthConfig(file = '/run/tuanzi-auth/auth.env', target = process.env) {
  let source;
  try {
    const info = statSync(file);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('认证配置必须为私有普通文件');
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const parsed = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at);
    if (at < 1 || !keys.has(key) || Object.hasOwn(parsed, key)) throw new Error('认证配置含不支持或重复的字段');
    parsed[key] = line.slice(at + 1);
  }
  Object.assign(target, parsed);
}
module.exports = { loadAuthConfig };
if (require.main === module) {
  loadAuthConfig();
  require('../dist/main.js');
}
