export const PERSONAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nav_user_records (
    user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind ENUM('favorites','history') NOT NULL,
    site_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    visit_type ENUM('detail','external') NULL,
    PRIMARY KEY (user_id,kind,site_id),
    KEY idx_personal_recent (user_id,kind,updated_at),
    CONSTRAINT fk_personal_user FOREIGN KEY (user_id) REFERENCES nav_users(id) ON DELETE CASCADE,
    CONSTRAINT fk_personal_site FOREIGN KEY (site_id) REFERENCES nav_sites(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
