CREATE TABLE IF NOT EXISTS operations (
  id VARCHAR(32) PRIMARY KEY,
  date DATE NULL,
  time TIME NULL,
  patient VARCHAR(255) NOT NULL,
  birth_date DATE NULL,
  blood_group VARCHAR(64) NULL,
  diagnosis TEXT NULL,
  `procedure` TEXT NULL,
  team_members JSON NOT NULL,
  anesthesiologists JSON NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'Заплановано',
  notes TEXT NULL,
  is_example TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attachments (
  id CHAR(36) PRIMARY KEY,
  operation_id VARCHAR(32) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_path VARCHAR(512) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_attachments_operation
    FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  INDEX idx_attachments_operation (operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type ENUM('team', 'anesthesiologists') NOT NULL,
  name VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_staff_type_name (type, name),
  INDEX idx_staff_type_order (type, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token CHAR(64) PRIMARY KEY,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS access_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event VARCHAR(64) NOT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  details JSON NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_access_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS change_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NULL,
  action VARCHAR(32) NOT NULL,
  summary VARCHAR(512) NOT NULL,
  changed_fields JSON NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_change_created (created_at),
  INDEX idx_change_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
