import { UPLOAD_QUOTA_SCHEMA_STATEMENTS } from './upload-quota-schema.ts';

/** 由迁移入口显式执行；请求路径不建表、不访问配置文件。 */
export const SUBMISSION_SCHEMA_STATEMENTS: string[] = [
  ...UPLOAD_QUOTA_SCHEMA_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS nav_submissions (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    request_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    payload JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    reviewed_at DATETIME(3) NULL,
    published_site_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (id),
    KEY idx_nav_submissions_status_created (status, created_at, id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];


