/** 由统一迁移脚本执行；请求路径不创建或迁移数据表。 */
export const ACCOUNT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nav_users (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    username VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    password_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY nav_users_username_unique (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS nav_user_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    KEY nav_user_sessions_user (user_id),
    KEY nav_user_sessions_expiry (expires_at),
    CONSTRAINT nav_user_sessions_user_fk FOREIGN KEY (user_id) REFERENCES nav_users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
] as const;
