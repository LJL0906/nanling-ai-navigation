/** MySQL 5.7+（需要 JSON 支持）。payload 保存原始记录，分类 count 由读取仓储重算。 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS nav_categories (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    slug VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sort_order INT NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_nav_categories_slug (slug)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS nav_sites (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    category_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    slug VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sort_order INT NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_nav_sites_category_slug (category_id, slug),
    CONSTRAINT fk_nav_sites_category FOREIGN KEY (category_id) REFERENCES nav_categories (id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
];
