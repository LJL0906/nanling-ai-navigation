/** 由部署迁移显式执行；请求路径不得建表或清理历史记录。 */
export const UPLOAD_QUOTA_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS nav_upload_quotas (
    scope VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    period DATE NOT NULL,
    attempts BIGINT UNSIGNED NOT NULL DEFAULT 0,
    bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, period),
    KEY idx_nav_upload_quotas_period (period)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin`,
];

/** 仅供独立维护任务使用；保留累计哨兵日，请勿在上传事务内执行。 */
export const UPLOAD_QUOTA_CLEANUP_SQL = `DELETE FROM nav_upload_quotas
  WHERE period <> '1970-01-01' AND period < UTC_DATE() - INTERVAL 35 DAY`;
