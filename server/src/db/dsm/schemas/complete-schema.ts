import { DatabaseSchema } from './types/schema';

export const COMPLETE_SCHEMA: DatabaseSchema = {
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'username', type: 'string', length: 500, unique: true, nullable: false },
        { name: 'nickname', type: 'string', length: 500, defaultValue: '' },
        { name: 'email', type: 'string', length: 500, defaultValue: '' },
        { name: 'password_hash', type: 'string', length: 500, nullable: false },
        { name: 'role', type: 'string', length: 20, defaultValue: 'member' },
        { name: 'role_level', type: 'integer', defaultValue: 1 },
        { name: 'status', type: 'integer', defaultValue: 1 },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_users_username', columns: ['username'] },
        { name: 'idx_users_role', columns: ['role'] },
        { name: 'idx_users_status', columns: ['status'] }
      ]
    },
    {
      name: 'teams',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'string', length: 500, nullable: false },
        { name: 'description', type: 'string', length: 2048, defaultValue: '' },
        { name: 'created_by', type: 'integer', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_teams_created_by', columns: ['created_by'] }
      ],
      foreignKeys: [
        { column: 'created_by', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'team_members',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'team_id', type: 'integer', nullable: false },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'role', type: 'string', length: 20, defaultValue: 'member' },
        { name: 'joined_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_team_members_team_id', columns: ['team_id'] },
        { name: 'idx_team_members_user_id', columns: ['user_id'] },
        { name: 'uq_team_members', columns: ['team_id', 'user_id'], unique: true }
      ],
      foreignKeys: [
        { column: 'team_id', refTable: 'teams', refColumn: 'id', onDelete: 'CASCADE' },
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'dns_accounts',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'type', type: 'string', length: 100, nullable: false },
        { name: 'name', type: 'string', length: 500, nullable: false },
        { name: 'config', type: 'json', nullable: false },
        { name: 'remark', type: 'text', nullable: false },
        { name: 'enabled', type: 'integer', defaultValue: true },
        { name: 'created_by', type: 'integer', nullable: false },
        { name: 'team_id', type: 'integer', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_dns_accounts_created_by', columns: ['created_by'] },
        { name: 'idx_dns_accounts_team_id', columns: ['team_id'] },
        { name: 'idx_dns_accounts_type', columns: ['type'] },
        { name: 'idx_dns_accounts_enabled', columns: ['enabled'] }
      ],
      foreignKeys: [
        { column: 'created_by', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' },
        { column: 'team_id', refTable: 'teams', refColumn: 'id', onDelete: 'SET NULL' }
      ]
    },
    {
      name: 'domains',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'account_id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', length: 500, nullable: false },
        { name: 'third_id', type: 'string', length: 500, defaultValue: '' },
        { name: 'remark', type: 'text', nullable: false },
        { name: 'is_hidden', type: 'integer', defaultValue: false },
        { name: 'enabled', type: 'integer', defaultValue: true },
        { name: 'record_count', type: 'integer', defaultValue: 0 },
        { name: 'expires_at', type: 'datetime', nullable: true },
        { name: 'apex_expires_at', type: 'datetime', nullable: true },
        { name: 'whois_status', type: 'text', nullable: true },
        { name: 'adapter_data', type: 'text', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_domains_account_id', columns: ['account_id'] },
        { name: 'idx_domains_name', columns: ['name'] },
        { name: 'idx_domains_is_hidden', columns: ['is_hidden'] },
        { name: 'idx_domains_enabled', columns: ['enabled'] }
      ],
      foreignKeys: [
        { column: 'account_id', refTable: 'dns_accounts', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'domain_permissions',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: true },
        { name: 'team_id', type: 'integer', nullable: true },
        { name: 'domain_id', type: 'integer', nullable: false },
        { name: 'sub', type: 'string', length: 500, defaultValue: '' },
        { name: 'permission', type: 'string', length: 20, defaultValue: 'write' },
      ],
      indexes: [
        { name: 'idx_domain_permissions_user_id', columns: ['user_id'] },
        { name: 'idx_domain_permissions_team_id', columns: ['team_id'] },
        { name: 'idx_domain_permissions_domain_id', columns: ['domain_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' },
        { column: 'team_id', refTable: 'teams', refColumn: 'id', onDelete: 'CASCADE' },
        { column: 'domain_id', refTable: 'domains', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'dns_records',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'domain_id', type: 'integer', nullable: false },
        { name: 'record_type', type: 'string', length: 20, nullable: false },
        { name: 'name', type: 'string', length: 500, nullable: false },
        { name: 'value', type: 'string', length: 2048, nullable: false },
        { name: 'ttl', type: 'integer', defaultValue: 600 },
        { name: 'priority', type: 'integer', nullable: true },
        { name: 'weight', type: 'integer', nullable: true },
        { name: 'port', type: 'integer', nullable: true },
        { name: 'status', type: 'string', length: 50, defaultValue: 'active' },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_dns_records_domain_id', columns: ['domain_id'] }
      ],
      foreignKeys: [
        { column: 'domain_id', refTable: 'domains', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'operation_logs',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', defaultValue: 0 },
        { name: 'action', type: 'string', length: 500, nullable: false },
        { name: 'domain', type: 'string', length: 500, defaultValue: '' },
        { name: 'data', type: 'json', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_operation_logs_user_id', columns: ['user_id'] },
        { name: 'idx_operation_logs_action', columns: ['action'] },
        { name: 'idx_operation_logs_domain', columns: ['domain'] },
        { name: 'idx_operation_logs_created_at', columns: ['created_at'] }
      ]
    },
    {
      name: 'oauth_user_links',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'provider', type: 'string', length: 100, nullable: false },
        { name: 'subject', type: 'string', length: 500, nullable: false },
        { name: 'email', type: 'string', length: 500, defaultValue: '' },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_oauth_user_links_user_id', columns: ['user_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'oauth_states',
      columns: [
        { name: 'state', type: 'string', length: 500, primaryKey: true },
        { name: 'mode', type: 'string', length: 20, nullable: false },
        { name: 'provider', type: 'string', length: 100, nullable: false },
        { name: 'user_id', type: 'integer', nullable: true },
        { name: 'expires_at', type: 'datetime', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_oauth_state_expires', columns: ['expires_at'] }
      ]
    },
    {
      name: 'runtime_secrets',
      columns: [
        { name: 'key', type: 'string', length: 500, primaryKey: true },
        { name: 'value', type: 'string', length: 4096, nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ]
    },
    {
      name: 'user_2fa',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'type', type: 'string', length: 50, defaultValue: 'totp' },
        { name: 'secret', type: 'string', length: 500, nullable: false },
        { name: 'backup_codes', type: 'json', nullable: false },
        { name: 'enabled', type: 'integer', defaultValue: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_user_2fa_user_id', columns: ['user_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'webauthn_credentials',
      columns: [
        { name: 'id', type: 'string', length: 500, primaryKey: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'public_key', type: 'string', length: 4096, nullable: false },
        { name: 'counter', type: 'integer', defaultValue: 0 },
        { name: 'device_type', type: 'string', length: 50, defaultValue: '' },
        { name: 'backed_up', type: 'integer', defaultValue: false },
        { name: 'transports', type: 'json', nullable: false },
        { name: 'name', type: 'string', length: 500, defaultValue: 'Passkey' },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'last_used_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'user_sessions',
      columns: [
        { name: 'id', type: 'string', length: 500, primaryKey: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'token', type: 'string', length: 500, unique: true, nullable: false },
        { name: 'user_agent', type: 'string', length: 2048, defaultValue: '' },
        { name: 'ip', type: 'string', length: 45, defaultValue: '' },
        { name: 'last_active_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'expires_at', type: 'datetime', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_user_sessions_token', columns: ['token'] },
        { name: 'idx_user_sessions_user_id', columns: ['user_id'] },
        { name: 'idx_user_sessions_expires_at', columns: ['expires_at'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'login_attempts',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'identifier', type: 'string', length: 500, nullable: false },
        { name: 'ip_address', type: 'string', length: 500, defaultValue: '' },
        { name: 'attempt_count', type: 'integer', defaultValue: 1 },
        { name: 'last_attempt_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'locked_until', type: 'datetime', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_login_attempts_identifier', columns: ['identifier'] },
        { name: 'idx_login_attempts_ip', columns: ['ip_address'] },
        { name: 'idx_login_attempts_locked', columns: ['locked_until'] }
      ]
    },
    {
      name: 'password_resets',
      columns: [
        { name: 'email', type: 'string', length: 500, primaryKey: true },
        { name: 'code', type: 'string', length: 6, nullable: false },
        { name: 'expires_at', type: 'datetime', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_password_resets_expires', columns: ['expires_at'] }
      ]
    },
    {
      name: 'system_settings',
      columns: [
        { name: 'key', type: 'string', length: 500, primaryKey: true },
        { name: 'value', type: 'string', length: 4096, nullable: false },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ]
    },
    {
      name: 'user_preferences',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', unique: true, nullable: false },
        { name: 'theme', type: 'string', length: 50, defaultValue: 'auto' },
        { name: 'language', type: 'string', length: 50, defaultValue: 'zh-CN' },
        { name: 'notifications_enabled', type: 'integer', defaultValue: true },
        { name: 'email_notifications', type: 'integer', defaultValue: true },
        { name: 'background_image', type: 'string', length: 2048, nullable: true },
        { name: 'avatar_image', type: 'string', length: 2048, nullable: true },
        { name: 'pinned_domains', type: 'json', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_user_preferences_user_id', columns: ['user_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'user_tokens',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', length: 500, nullable: false },
        { name: 'token_hash', type: 'string', length: 500, unique: true, nullable: false },
        { name: 'allowed_domains', type: 'json', nullable: false },
        { name: 'allowed_services', type: 'json', nullable: false },
        { name: 'start_time', type: 'datetime', nullable: true },
        { name: 'end_time', type: 'datetime', nullable: true },
        { name: 'max_role', type: 'integer', defaultValue: 1 },
        { name: 'is_active', type: 'integer', defaultValue: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'last_used_at', type: 'datetime', nullable: true },
      ],
      indexes: [
        { name: 'idx_user_tokens_user_id', columns: ['user_id'] },
        { name: 'idx_user_tokens_token_hash', columns: ['token_hash'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'failover_configs',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'domain_id', type: 'integer', nullable: false },
        { name: 'record_id', type: 'integer', nullable: false },
        { name: 'record_type', type: 'string', length: 50, nullable: false },
        { name: 'record_name', type: 'string', length: 500, nullable: false },
        { name: 'primary_value', type: 'string', length: 500, nullable: false },
        { name: 'backup_value', type: 'string', length: 500, nullable: false },
        { name: 'check_interval', type: 'integer', defaultValue: 60 },
        { name: 'check_timeout', type: 'integer', defaultValue: 5 },
        { name: 'check_method', type: 'string', length: 50, defaultValue: 'ping' },
        { name: 'check_port', type: 'integer', nullable: true },
        { name: 'check_path', type: 'string', length: 500, nullable: true },
        { name: 'check_expect', type: 'string', length: 500, nullable: true },
        { name: 'enabled', type: 'integer', defaultValue: true },
        { name: 'created_by', type: 'integer', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_failover_configs_domain_id', columns: ['domain_id'] },
        { name: 'idx_failover_configs_enabled', columns: ['enabled'] }
      ],
      foreignKeys: [
        { column: 'domain_id', refTable: 'domains', refColumn: 'id', onDelete: 'CASCADE' },
        { column: 'created_by', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'failover_status',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'config_id', type: 'integer', unique: true, nullable: false },
        { name: 'current_value', type: 'string', length: 500, nullable: false },
        { name: 'status', type: 'string', length: 20, defaultValue: 'primary' },
        { name: 'last_check_at', type: 'datetime', nullable: true },
        { name: 'last_failover_at', type: 'datetime', nullable: true },
        { name: 'fail_count', type: 'integer', defaultValue: 0 },
        { name: 'success_count', type: 'integer', defaultValue: 0 },
        { name: 'last_error', type: 'string', length: 2048, nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_failover_status_config_id', columns: ['config_id'] }
      ],
      foreignKeys: [
        { column: 'config_id', refTable: 'failover_configs', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'servicemonitor_monitors',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'name', type: 'string', length: 500, nullable: false },
        { name: 'type', type: 'string', length: 50, nullable: false }, // ssl_certificate | endpoint | dns_failover
        { name: 'target', type: 'string', length: 1024, nullable: false }, // domain/URL being monitored
        { name: 'domain_id', type: 'integer', nullable: true }, // FK for dns_failover type
        { name: 'config', type: 'json', nullable: false }, // type-specific config
        { name: 'check_interval', type: 'integer', defaultValue: 300 },
        { name: 'check_timeout', type: 'integer', defaultValue: 10 },
        { name: 'enabled', type: 'integer', defaultValue: true },
        { name: 'notify_on_failure', type: 'integer', defaultValue: true },
        { name: 'notify_on_recovery', type: 'integer', defaultValue: true },
        { name: 'parent_id', type: 'integer', nullable: true }, // FK: endpoint monitor bind for failover
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_servicemonitor_user_id', columns: ['user_id'] },
        { name: 'idx_servicemonitor_type', columns: ['type'] },
        { name: 'idx_servicemonitor_enabled', columns: ['enabled'] },
        { name: 'idx_servicemonitor_domain_id', columns: ['domain_id'] },
        { name: 'idx_servicemonitor_parent_id', columns: ['parent_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' },
        { column: 'domain_id', refTable: 'domains', refColumn: 'id', onDelete: 'SET NULL' },
        { column: 'parent_id', refTable: 'servicemonitor_monitors', refColumn: 'id', onDelete: 'SET NULL' }
      ]
    },
    {
      name: 'servicemonitor_status',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'monitor_id', type: 'integer', unique: true, nullable: false },
        { name: 'status', type: 'string', length: 20, defaultValue: 'unknown' }, // ok | warning | error | unknown
        { name: 'last_check_at', type: 'datetime', nullable: true },
        { name: 'last_success_at', type: 'datetime', nullable: true },
        { name: 'last_failure_at', type: 'datetime', nullable: true },
        { name: 'last_error', type: 'string', length: 2048, nullable: true },
        { name: 'last_response_time', type: 'integer', nullable: true },
        { name: 'consecutive_failures', type: 'integer', defaultValue: 0 },
        { name: 'consecutive_successes', type: 'integer', defaultValue: 0 },
        { name: 'result_data', type: 'json', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_servicemonitor_status_monitor', columns: ['monitor_id'] },
        { name: 'idx_servicemonitor_status_status', columns: ['status'] }
      ],
      foreignKeys: [
        { column: 'monitor_id', refTable: 'servicemonitor_monitors', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'security_policies',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'require_2fa_global', type: 'integer', defaultValue: false },
        { name: 'min_password_length', type: 'integer', defaultValue: 8 },
        { name: 'min_password_strength', type: 'integer', defaultValue: 2 },
        { name: 'session_timeout_hours', type: 'integer', defaultValue: 24 },
        { name: 'max_login_attempts', type: 'integer', defaultValue: 5 },
        { name: 'lockout_duration_minutes', type: 'integer', defaultValue: 30 },
        { name: 'allow_remember_device', type: 'integer', defaultValue: true },
        { name: 'trusted_device_days', type: 'integer', defaultValue: 30 },
        { name: 'require_password_change_on_first_login', type: 'integer', defaultValue: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ]
    },
    {
      name: 'user_security_settings',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', unique: true, nullable: false },
        { name: 'require_2fa', type: 'integer', defaultValue: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_user_security_settings_user_id', columns: ['user_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'trusted_devices',
      columns: [
        { name: 'id', type: 'string', length: 500, primaryKey: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'device_name', type: 'string', length: 500, nullable: false },
        { name: 'device_fingerprint', type: 'string', length: 500, nullable: false },
        { name: 'user_agent', type: 'string', length: 2048, nullable: true },
        { name: 'ip_address', type: 'string', length: 500, nullable: true },
        { name: 'last_used_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'expires_at', type: 'datetime', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_trusted_devices_user_id', columns: ['user_id'] },
        { name: 'idx_trusted_devices_fingerprint', columns: ['device_fingerprint'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'user_ns_monitor_prefs',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', unique: true, nullable: false },
        { name: 'notify_email', type: 'integer', defaultValue: true },
        { name: 'notify_channels', type: 'integer', defaultValue: true },
        { name: 'check_interval', type: 'integer', defaultValue: 3600 },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_user_ns_monitor_prefs_user_id', columns: ['user_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'ns_monitor_domains',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'domain_name', type: 'string', length: 500, defaultValue: '' },
        { name: 'expected_ns', type: 'string', length: 2048, defaultValue: '' },
        { name: 'current_ns', type: 'string', length: 2048, defaultValue: '' },
        { name: 'encrypted_ns', type: 'string', length: 4096, nullable: true },
        { name: 'plain_ns', type: 'string', length: 4096, nullable: true },
        { name: 'is_poisoned', type: 'integer', defaultValue: false },
        { name: 'status', type: 'string', length: 20, defaultValue: 'ok' },
        { name: 'enabled', type: 'integer', defaultValue: true },
        { name: 'last_check_at', type: 'datetime', nullable: true },
        { name: 'last_alert_at', type: 'datetime', nullable: true },
        { name: 'alert_count', type: 'integer', defaultValue: 0 },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_ns_monitor_domains_user_id', columns: ['user_id'] },
        { name: 'idx_ns_monitor_domains_domain_name', columns: ['domain_name'] },
        { name: 'idx_ns_monitor_domains_enabled', columns: ['enabled'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'rdap_server_cache',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'tld', type: 'string', length: 500, unique: true, nullable: false },
        { name: 'servers', type: 'string', length: 4096, nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_rdap_server_cache_tld', columns: ['tld'] }
      ]
    },
    {
      name: 'system_cache',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'cache_key', type: 'string', length: 500, unique: true, nullable: false },
        { name: 'cache_value', type: 'string', length: 4096, nullable: false },
        { name: 'expires_at', type: 'datetime', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_system_cache_key', columns: ['cache_key'] },
        { name: 'idx_system_cache_expires', columns: ['expires_at'] }
      ]
    },
    {
      name: 'grouped_domains_cache',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'cache_type', type: 'string', length: 50, nullable: false },
        { name: 'version', type: 'bigint', nullable: false },
        { name: 'cache_data', type: 'text', nullable: false },
        { name: 'expires_at', type: 'datetime', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_grouped_cache_user_type', columns: ['user_id', 'cache_type'], unique: true },
        { name: 'idx_grouped_cache_expires', columns: ['expires_at'] },
      ]
    },
    {
      name: 'renewable_domains',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'account_id', type: 'integer', nullable: false },
        { name: 'provider_type', type: 'string', length: 50, nullable: false },
        { name: 'domain_name', type: 'string', length: 500, nullable: false },
        { name: 'third_id', type: 'string', length: 500, defaultValue: '' },
        { name: 'full_domain', type: 'string', length: 500, nullable: false },
        { name: 'expires_at', type: 'datetime', nullable: true },
        { name: 'never_expires', type: 'integer', defaultValue: false },
        { name: 'status', type: 'string', length: 20, defaultValue: 'active' },
        { name: 'remark', type: 'text', nullable: true },
        { name: 'enabled', type: 'integer', defaultValue: true },
        { name: 'last_renewed_at', type: 'datetime', nullable: true },
        { name: 'adapter_data', type: 'text', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_renewable_domains_account_id', columns: ['account_id'] },
        { name: 'idx_renewable_domains_provider_type', columns: ['provider_type'] },
        { name: 'idx_renewable_domains_expires_at', columns: ['expires_at'] },
        { name: 'idx_renewable_domains_enabled', columns: ['enabled'] }
      ],
      foreignKeys: [
        { column: 'account_id', refTable: 'dns_accounts', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'whois_cache',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'domain_name', type: 'string', length: 500, unique: true, nullable: false },
        { name: 'whois_data', type: 'json', nullable: true },
        { name: 'status', type: 'string', length: 500, nullable: true },
        { name: 'cached_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'expires_at', type: 'datetime', nullable: true },
      ],
      indexes: [
        { name: 'idx_whois_cache_domain_name', columns: ['domain_name'] },
        { name: 'idx_whois_cache_expires_at', columns: ['expires_at'] }
      ]
    },
    {
      name: 'schema_versions',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'version', type: 'string', length: 50, unique: true, nullable: false },
        { name: 'semantic_version', type: 'string', length: 20, nullable: true },
        { name: 'description', type: 'string', length: 2048, nullable: true },
        { name: 'applied_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'success', type: 'integer', defaultValue: true },
        { name: 'error_message', type: 'string', length: 4096, nullable: true },
        { name: 'execution_time_ms', type: 'integer', nullable: true },
        { name: 'system_type', type: 'string', length: 50, defaultValue: 'hidns' },
      ],
      indexes: [
        { name: 'idx_schema_versions_version', columns: ['version'] },
        { name: 'idx_schema_versions_applied_at', columns: ['applied_at'] },
        { name: 'idx_schema_versions_system_type', columns: ['system_type'] },
        { name: 'idx_schema_versions_semantic_version', columns: ['semantic_version'] }
      ]
    },
    // ========================================
    // MCP (Model Context Protocol) Tables
    // ========================================
    {
      name: 'mcp_global_config',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'enabled', type: 'boolean', defaultValue: false },
        { name: 'updated_by', type: 'integer', nullable: true },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      foreignKeys: [
        { column: 'updated_by', refTable: 'users', refColumn: 'id', onDelete: 'SET NULL' }
      ]
    },
    {
      name: 'mcp_user_api_keys',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'api_key', type: 'string', length: 512, unique: true, nullable: false },
        { name: 'description', type: 'string', length: 500, defaultValue: '' },
        { name: 'last_used_at', type: 'datetime', nullable: true },
        { name: 'expires_at', type: 'datetime', nullable: true },
        { name: 'revoked_at', type: 'datetime', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_mcp_api_keys_user_id', columns: ['user_id'] },
        { name: 'idx_mcp_api_keys_revoked', columns: ['revoked_at'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'mcp_oauth_clients',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'client_id', type: 'string', length: 500, unique: true, nullable: false },
        { name: 'client_secret', type: 'string', length: 512, nullable: false },
        { name: 'user_id', type: 'integer', nullable: true },
        { name: 'app_name', type: 'string', length: 500, nullable: false },
        { name: 'redirect_uris', type: 'json', nullable: false },
        { name: 'scope', type: 'json', nullable: true },
        { name: 'expires_at', type: 'datetime', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_mcp_oauth_clients_user_id', columns: ['user_id'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'mcp_oauth_access_tokens',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'access_token', type: 'string', length: 512, unique: true, nullable: false },
        { name: 'refresh_token', type: 'string', length: 512, unique: true, nullable: false },
        { name: 'client_id', type: 'string', length: 500, nullable: false },
        { name: 'user_id', type: 'integer', nullable: true },
        { name: 'scope', type: 'json', nullable: true },
        { name: 'expires_at', type: 'datetime', nullable: false },
        { name: 'revoked_at', type: 'datetime', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_mcp_tokens_user_id', columns: ['user_id'] },
        { name: 'idx_mcp_tokens_expires', columns: ['expires_at'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'mcp_audit_logs',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'auth_type', type: 'string', length: 20, nullable: false },
        { name: 'client_id', type: 'string', length: 500, nullable: true },
        { name: 'module', type: 'string', length: 50, nullable: false },
        { name: 'action', type: 'string', length: 50, nullable: false },
        { name: 'resource_type', type: 'string', length: 50, nullable: true },
        { name: 'resource_id', type: 'string', length: 500, nullable: true },
        { name: 'request_params', type: 'json', nullable: true },
        { name: 'response_status', type: 'string', length: 20, nullable: true },
        { name: 'ip_address', type: 'string', length: 45, nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_mcp_audit_user_id', columns: ['user_id'] },
        { name: 'idx_mcp_audit_module', columns: ['module'] },
        { name: 'idx_mcp_audit_created_at', columns: ['created_at'] }
      ],
      foreignKeys: [
        { column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'CASCADE' }
      ]
    },
    {
      name: 'mcp_oauth_auth_codes',
      columns: [
        { name: 'code', type: 'string', length: 512, unique: true, nullable: false },
        { name: 'client_id', type: 'string', length: 500, nullable: false },
        { name: 'user_id', type: 'integer', nullable: false },
        { name: 'redirect_uri', type: 'string', length: 1024, nullable: false },
        { name: 'scope', type: 'string', length: 1024, nullable: true },
        { name: 'expires_at', type: 'datetime', nullable: false },
        { name: 'used', type: 'boolean', defaultValue: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_mcp_auth_codes_code', columns: ['code'] },
        { name: 'idx_mcp_auth_codes_expires', columns: ['expires_at'] }
      ]
    },
    {
      name: 'mcp_oauth_refresh_tokens',
      columns: [
        { name: 'refresh_token', type: 'string', length: 512, unique: true, nullable: false },
        { name: 'client_id', type: 'string', length: 500, nullable: false },
        { name: 'user_id', type: 'integer', nullable: true },
        { name: 'scope', type: 'string', length: 1024, nullable: true },
        { name: 'expires_at', type: 'datetime', nullable: false },
        { name: 'revoked_at', type: 'datetime', nullable: true },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_mcp_refresh_tokens_token', columns: ['refresh_token'] },
        { name: 'idx_mcp_refresh_tokens_expires', columns: ['expires_at'] }
      ]
    },
    {
      name: 'resource_metrics',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'cpu_percent', type: 'number', nullable: true },
        { name: 'memory_percent', type: 'number', nullable: true },
        { name: 'memory_mb', type: 'number', nullable: true },
        { name: 'disk_percent', type: 'number', nullable: true },
        { name: 'uptime_seconds', type: 'number', nullable: true },
        { name: 'task_queue_depth', type: 'integer', defaultValue: 0 },
        { name: 'db_queries_total', type: 'integer', defaultValue: 0 },
        { name: 'db_errors_total', type: 'integer', defaultValue: 0 },
        { name: 'http_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'http_avg_ms', type: 'number', nullable: true },
        { name: 'http_p50_ms', type: 'number', nullable: true },
        { name: 'http_p95_ms', type: 'number', nullable: true },
        { name: 'http_p99_ms', type: 'number', nullable: true },
        { name: 'dns_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'dns_avg_ms', type: 'number', nullable: true },
        { name: 'dns_p50_ms', type: 'number', nullable: true },
        { name: 'dns_p95_ms', type: 'number', nullable: true },
        { name: 'dns_p99_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'dns_encrypted_avg_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_p50_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_p95_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_p99_ms', type: 'number', nullable: true },
        { name: 'dns_plain_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'dns_plain_avg_ms', type: 'number', nullable: true },
        { name: 'dns_plain_p50_ms', type: 'number', nullable: true },
        { name: 'dns_plain_p95_ms', type: 'number', nullable: true },
        { name: 'dns_plain_p99_ms', type: 'number', nullable: true },
        { name: 'sqlite_io_reads', type: 'integer', defaultValue: 0 },
        { name: 'sqlite_io_writes', type: 'integer', defaultValue: 0 },
        { name: 'recorded_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ]
    },
    {
      name: 'resource_metric_history',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'recorded_at', type: 'datetime', nullable: false },
        { name: 'cpu_percent', type: 'number', nullable: true },
        { name: 'memory_percent', type: 'number', nullable: true },
        { name: 'memory_mb', type: 'number', nullable: true },
        { name: 'disk_percent', type: 'number', nullable: true },
        { name: 'uptime_seconds', type: 'number', nullable: true },
        { name: 'task_queue_depth', type: 'integer', defaultValue: 0 },
        { name: 'db_queries_total', type: 'integer', defaultValue: 0 },
        { name: 'db_errors_total', type: 'integer', defaultValue: 0 },
        { name: 'http_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'http_avg_ms', type: 'number', nullable: true },
        { name: 'http_p50_ms', type: 'number', nullable: true },
        { name: 'http_p95_ms', type: 'number', nullable: true },
        { name: 'http_p99_ms', type: 'number', nullable: true },
        { name: 'dns_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'dns_avg_ms', type: 'number', nullable: true },
        { name: 'dns_p50_ms', type: 'number', nullable: true },
        { name: 'dns_p95_ms', type: 'number', nullable: true },
        { name: 'dns_p99_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'dns_encrypted_avg_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_p50_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_p95_ms', type: 'number', nullable: true },
        { name: 'dns_encrypted_p99_ms', type: 'number', nullable: true },
        { name: 'dns_plain_probe_count', type: 'integer', defaultValue: 0 },
        { name: 'dns_plain_avg_ms', type: 'number', nullable: true },
        { name: 'dns_plain_p50_ms', type: 'number', nullable: true },
        { name: 'dns_plain_p95_ms', type: 'number', nullable: true },
        { name: 'dns_plain_p99_ms', type: 'number', nullable: true },
        { name: 'sqlite_io_reads', type: 'integer', defaultValue: 0 },
        { name: 'sqlite_io_writes', type: 'integer', defaultValue: 0 },
      ],
      indexes: [
        { name: 'idx_rmh_recorded_at', columns: ['recorded_at'] }
      ]
    },
    {
      name: 'workflows',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'string', length: 200, nullable: false },
        { name: 'owner_id', type: 'integer', nullable: false },
        { name: 'enabled', type: 'integer', defaultValue: 1 },
        { name: 'trigger_type', type: 'string', length: 50, nullable: false },
        { name: 'trigger_config', type: 'text', nullable: true },
        { name: 'definition', type: 'text', nullable: false },
        { name: 'created_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
      ],
      indexes: [
        { name: 'idx_workflows_owner_id', columns: ['owner_id'] },
        { name: 'idx_workflows_enabled', columns: ['enabled'] }
      ]
    },
    {
      name: 'workflow_runs',
      columns: [
        { name: 'id', type: 'id', primaryKey: true, autoIncrement: true },
        { name: 'workflow_id', type: 'integer', nullable: false },
        { name: 'trace_id', type: 'string', length: 64, nullable: false },
        { name: 'status', type: 'string', length: 20, nullable: false },
        { name: 'trigger_event', type: 'text', nullable: true },
        { name: 'error', type: 'text', nullable: true },
        { name: 'depth', type: 'integer', defaultValue: 0 },
        { name: 'started_at', type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' },
        { name: 'finished_at', type: 'datetime', nullable: true },
      ],
      indexes: [
        { name: 'idx_workflow_runs_workflow_id', columns: ['workflow_id'] },
        { name: 'idx_workflow_runs_trace_id', columns: ['trace_id'] }
      ]
    }
  ]
};