-- Flockwise API schema (MySQL 8 / MariaDB 10.6+). Import in hPanel > Databases > phpMyAdmin.
-- Amounts are integers in minor units (paise). Times are UTC.

CREATE TABLE IF NOT EXISTS funds (
  id              VARCHAR(40)  NOT NULL PRIMARY KEY,
  church_id       VARCHAR(40)  NOT NULL,
  name            VARCHAR(120) NOT NULL,
  description     VARCHAR(500) NOT NULL DEFAULT '',
  tax_deductible  TINYINT(1)   NOT NULL DEFAULT 1,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  goal            BIGINT       NULL,
  sort_order      INT          NOT NULL DEFAULT 0,
  KEY idx_funds_church (church_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS donations (
  id                   VARCHAR(40)  NOT NULL PRIMARY KEY,
  church_id            VARCHAR(40)  NOT NULL,
  member_id            VARCHAR(40)  NULL,
  donor_name           VARCHAR(160) NOT NULL,
  donor_email          VARCHAR(190) NULL,
  donor_phone          VARCHAR(32)  NULL,
  fund_id              VARCHAR(40)  NOT NULL,
  fund_name            VARCHAR(120) NOT NULL,
  amount               BIGINT       NOT NULL,
  currency             CHAR(3)      NOT NULL,
  frequency            ENUM('once','monthly') NOT NULL DEFAULT 'once',
  status               ENUM('pending','succeeded','failed','refunded') NOT NULL DEFAULT 'pending',
  method               VARCHAR(20)  NULL,
  pan                  CHAR(10)     NULL,
  donor_citizenship    ENUM('IN','OTHER') NOT NULL DEFAULT 'IN',
  fcra                 TINYINT(1)   NOT NULL DEFAULT 0,
  provider             VARCHAR(20)  NOT NULL,
  provider_ref         VARCHAR(64)  NULL,
  provider_payment_id  VARCHAR(64)  NULL,
  created_at           DATETIME     NOT NULL,
  paid_at              DATETIME     NULL,
  UNIQUE KEY uq_donations_payment (provider_payment_id),
  KEY idx_donations_church_created (church_id, created_at),
  KEY idx_donations_member (member_id),
  KEY idx_donations_ref (provider_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Razorpay subscription plans are reused per amount + currency + account.
CREATE TABLE IF NOT EXISTS razorpay_plans (
  plan_key  VARCHAR(80) NOT NULL PRIMARY KEY,
  plan_id   VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Starter funds. Change CHURCH_ID to match your .env.
INSERT IGNORE INTO funds (id, church_id, name, description, tax_deductible, sort_order) VALUES
  ('fd_tithe',    'ch_1', 'Tithes & Offerings', 'General ministry of the church.', 1, 1),
  ('fd_building', 'ch_1', 'Building Fund',      'New sanctuary construction.',     1, 2),
  ('fd_missions', 'ch_1', 'Missions',           'Church planting in North India.', 0, 3);
