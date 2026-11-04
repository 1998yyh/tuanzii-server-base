-- 只增加会话与授权数据；部署前备份。DDL 仅向前，回退旧应用时保留新增表列。
ALTER TABLE users ADD COLUMN auth_version INT UNSIGNED NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS auth_sessions (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  auth_version INT UNSIGNED NOT NULL,
  remembered TINYINT NOT NULL DEFAULT 0,
  user_agent VARCHAR(180) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_auth_sessions_token(token_hash),
  KEY ix_auth_sessions_user(user_id),
  KEY ix_auth_sessions_expiry(expires_at),
  CONSTRAINT fk_auth_sessions_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS user_app_grants (
  user_id VARCHAR(36) NOT NULL,
  app_id VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, app_id),
  CONSTRAINT fk_user_app_grants_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- 用户已明确授权：仅现有用户名 tuanzi。若账号不存在则不授权任何人，切换前核对结果。
INSERT INTO user_app_grants (user_id, app_id)
SELECT id, 'dsh' FROM users WHERE username = 'tuanzi';
