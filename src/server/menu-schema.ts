/** 菜单为独立实体；配置快照不包含密码、令牌或浏览器个人数据。 */
export const MENU_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS nav_menus (
    id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
    location VARCHAR(32) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    label VARCHAR(255) NOT NULL,
    href TEXT NULL,
    icon VARCHAR(191) NULL,
    sort_order INT NOT NULL,
    enabled TINYINT(1) NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (id),
    KEY idx_nav_menus_location (location, parent_id, sort_order),
    CONSTRAINT fk_nav_menus_parent FOREIGN KEY (parent_id) REFERENCES nav_menus(id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS nav_settings (
    setting_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (setting_key)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
