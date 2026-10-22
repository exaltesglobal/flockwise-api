-- Flockwise API storage (MySQL 8 / MariaDB 10.6+).
-- You do not need to import this: the API creates the table itself on first start.
-- It is here for reference, or if your database user cannot run CREATE TABLE.
-- Every record (people, events, gifts, plans, ...) is one JSON row, keyed by church.

CREATE TABLE IF NOT EXISTS records (
  church_id  VARCHAR(40)  NOT NULL,
  kind       VARCHAR(32)  NOT NULL,
  id         VARCHAR(80)  NOT NULL,
  data       LONGTEXT     NOT NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (church_id, kind, id),
  KEY idx_records_kind (church_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
