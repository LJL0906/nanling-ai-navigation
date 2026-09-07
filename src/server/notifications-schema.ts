/** 显式迁移执行；事件不引用可删除的站点/提交外键，保留历史。 */
export const NOTIFICATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nav_notifications (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    event_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind ENUM('site','submission','announcement') NOT NULL,
    visibility ENUM('public','private') NOT NULL,
    recipient_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL,
    status VARCHAR(32) NULL,
    reason TEXT NULL,
    site_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    submission_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY notification_event_unique (event_key),
    KEY notification_public_page (visibility, kind, created_at, id),
    KEY notification_private_page (recipient_user_id, visibility, kind, created_at, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
