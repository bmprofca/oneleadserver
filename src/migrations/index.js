// Ordered list of schema migrations. Append only — never edit or reorder a
// migration once it has run in production. Every migration is additive and
// idempotent: it adds tables, columns, indexes or enum values, and never drops
// or rewrites existing data.
const {
  addColumn,
  addIndex,
  createTable,
  columnType,
} = require('./helpers');

module.exports = [
  {
    id: '2026_10_27_001_lead_crm_fields',
    description: 'Deal value, close date, lost reason, activity/stage timestamps, archiving and phone index on leads',
    async up(conn, log) {
      await addColumn(conn, 'leads', 'deal_value', 'DECIMAL(14,2) NULL AFTER status', log);
      await addColumn(conn, 'leads', 'expected_close_date', 'DATE NULL AFTER deal_value', log);
      await addColumn(conn, 'leads', 'lost_reason', 'VARCHAR(255) NULL AFTER expected_close_date', log);
      await addColumn(conn, 'leads', 'phone_normalized', 'VARCHAR(20) NULL AFTER phone', log);
      await addColumn(conn, 'leads', 'last_activity_at', 'DATETIME NULL', log);
      await addColumn(conn, 'leads', 'stage_changed_at', 'DATETIME NULL', log);
      await addColumn(conn, 'leads', 'archived_at', 'DATETIME NULL', log);
      await addColumn(conn, 'leads', 'archived_by', 'INT NULL', log);
      await addColumn(conn, 'leads', 'merged_into', 'VARCHAR(120) NULL', log);

      // Backfill derived columns from existing data (no existing values are changed).
      const [phones] = await conn.query(
        'SELECT id, phone FROM leads WHERE phone IS NOT NULL AND phone_normalized IS NULL'
      );
      for (const row of phones) {
        const digits = String(row.phone).replace(/\D/g, '');
        const normalized = digits.length >= 10 ? digits.slice(-10) : digits || null;
        if (normalized) {
          await conn.query('UPDATE leads SET phone_normalized = ?, updated_at = updated_at WHERE id = ?', [
            normalized,
            row.id,
          ]);
        }
      }
      if (phones.length) log(`  ~ normalized ${phones.length} phone number(s)`);

      await conn.query(
        `UPDATE leads l
         LEFT JOIN (
           SELECT lead_id, MAX(created_at) AS changed_at FROM lead_status_history GROUP BY lead_id
         ) h ON h.lead_id = l.id
         SET l.stage_changed_at = COALESCE(h.changed_at, l.created_at),
             l.last_activity_at = COALESCE(h.changed_at, l.updated_at),
             l.updated_at = l.updated_at
         WHERE l.stage_changed_at IS NULL`
      );

      await addIndex(conn, 'leads', 'idx_leads_status', 'status', log);
      await addIndex(conn, 'leads', 'idx_leads_updated', 'updated_at', log);
      await addIndex(conn, 'leads', 'idx_leads_created', 'created_at', log);
      await addIndex(conn, 'leads', 'idx_leads_phone_norm', 'phone_normalized', log);
      await addIndex(conn, 'leads', 'idx_leads_archived', 'archived_at', log);
      await addIndex(conn, 'leads', 'idx_leads_source', 'source', log);
    },
  },

  {
    id: '2026_10_27_002_tags',
    description: 'Tags and lead_tags tables',
    async up(conn, log) {
      await createTable(
        conn,
        'tags',
        `CREATE TABLE tags (
           id INT AUTO_INCREMENT PRIMARY KEY,
           name VARCHAR(60) NOT NULL,
           color VARCHAR(20) NOT NULL DEFAULT 'slate',
           created_by INT NULL,
           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
           UNIQUE KEY uq_tags_name (name),
           CONSTRAINT fk_tags_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        log
      );
      await createTable(
        conn,
        'lead_tags',
        `CREATE TABLE lead_tags (
           lead_id VARCHAR(120) NOT NULL,
           tag_id INT NOT NULL,
           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
           PRIMARY KEY (lead_id, tag_id),
           INDEX idx_lead_tags_tag (tag_id),
           CONSTRAINT fk_lead_tags_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
           CONSTRAINT fk_lead_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        log
      );
    },
  },

  {
    id: '2026_10_27_003_activities',
    description: 'Extend communications into a full activity log (notes, WhatsApp, meetings)',
    async up(conn, log) {
      const type = await columnType(conn, 'communications', 'type');
      if (type && !type.includes("'note'")) {
        await conn.query(
          `ALTER TABLE communications
           MODIFY type ENUM('call','message','email','note','whatsapp','meeting') NOT NULL`
        );
        log('  ~ communications.type: added note, whatsapp, meeting');
      }
      await addColumn(conn, 'communications', 'occurred_at', 'DATETIME NULL AFTER duration_seconds', log);
      await conn.query('UPDATE communications SET occurred_at = created_at WHERE occurred_at IS NULL');
      await addIndex(conn, 'communications', 'idx_comm_lead_time', 'lead_id, occurred_at', log);
    },
  },

  {
    id: '2026_10_27_004_tasks',
    description: 'Reminder priority and completion time; task and calendar indexes',
    async up(conn, log) {
      await addColumn(
        conn,
        'reminders',
        'priority',
        "ENUM('low','normal','high') NOT NULL DEFAULT 'normal' AFTER description",
        log
      );
      await addColumn(conn, 'reminders', 'completed_at', 'DATETIME NULL AFTER is_completed', log);
      await conn.query(
        `UPDATE reminders SET completed_at = updated_at, updated_at = updated_at
         WHERE is_completed = 1 AND completed_at IS NULL`
      );
      await addIndex(conn, 'reminders', 'idx_reminders_due', 'user_id, is_completed, remind_at', log);
      await addIndex(conn, 'reminders', 'idx_reminders_lead_open', 'lead_id, is_completed, remind_at', log);
      await addIndex(conn, 'appointments', 'idx_appointments_user_start', 'user_id, start_at', log);
      await addIndex(conn, 'appointments', 'idx_appointments_start', 'start_at', log);
    },
  },

  {
    id: '2026_10_27_005_audit_settings',
    description: 'Audit log, app settings, auto-assignment flag on users, product price',
    async up(conn, log) {
      await createTable(
        conn,
        'audit_logs',
        `CREATE TABLE audit_logs (
           id BIGINT AUTO_INCREMENT PRIMARY KEY,
           user_id INT NULL,
           entity_type VARCHAR(40) NOT NULL,
           entity_id VARCHAR(120) NULL,
           action VARCHAR(40) NOT NULL,
           summary VARCHAR(255) NULL,
           changes MEDIUMTEXT NULL,
           ip_address VARCHAR(64) NULL,
           created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
           INDEX idx_audit_entity (entity_type, entity_id),
           INDEX idx_audit_created (created_at),
           INDEX idx_audit_user (user_id),
           CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        log
      );
      await createTable(
        conn,
        'app_settings',
        `CREATE TABLE app_settings (
           setting_key VARCHAR(80) PRIMARY KEY,
           setting_value TEXT NULL,
           updated_by INT NULL,
           updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
         ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
        log
      );
      await addColumn(conn, 'users', 'auto_assign', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER status', log);
      await addColumn(conn, 'products', 'price', 'DECIMAL(14,2) NULL AFTER description', log);
    },
  },

  {
    id: '2026_10_28_006_business_profile_url',
    description: 'Google Business Profile link on leads (CSV "Business Profile URL" column)',
    async up(conn, log) {
      await addColumn(conn, 'leads', 'business_profile_url', 'TEXT NULL AFTER maps_url', log);
    },
  },
];
