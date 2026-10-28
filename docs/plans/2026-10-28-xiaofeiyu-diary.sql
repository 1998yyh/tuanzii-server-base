-- 小肥鱼日记接入共享后台。DDL仅前进；不要在执行后修改此文件名。
CREATE TABLE IF NOT EXISTS xiaofeiyu_diary_entries (
  id varchar(36) NOT NULL PRIMARY KEY,
  title varchar(300) NOT NULL,
  content mediumtext NOT NULL,
  is_read tinyint NOT NULL DEFAULT 0,
  created_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  KEY idx_xiaofeiyu_diary_created (created_at, id),
  KEY idx_xiaofeiyu_diary_unread (is_read, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
