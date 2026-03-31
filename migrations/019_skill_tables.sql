-- Migration 019: Skill Registry Tables
-- installed_skills + skill_submodules + skill_credentials + skill_migrations

-- Installed skills registry
CREATE TABLE IF NOT EXISTS installed_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    version TEXT NOT NULL DEFAULT '1.0.0',
    domain TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT,
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_installed_skills_enabled ON installed_skills(enabled);
CREATE INDEX IF NOT EXISTS idx_installed_skills_domain ON installed_skills(domain);

-- Skill submodules (components within a skill)
CREATE TABLE IF NOT EXISTS skill_submodules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    module_name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1.0.0',
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (skill_id) REFERENCES installed_skills(id) ON DELETE CASCADE,
    UNIQUE(skill_id, module_name)
);
CREATE INDEX IF NOT EXISTS idx_skill_submodules_skill_id ON skill_submodules(skill_id);

-- Encrypted credentials per skill
CREATE TABLE IF NOT EXISTS skill_credentials (
    skill_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    PRIMARY KEY (skill_id, key_name),
    FOREIGN KEY (skill_id) REFERENCES installed_skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_credentials_skill ON skill_credentials(skill_id);

-- Migration tracking per skill (skill-level schema evolution)
CREATE TABLE IF NOT EXISTS skill_migrations (
    skill_id INTEGER NOT NULL,
    migration_name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (skill_id, migration_name),
    FOREIGN KEY (skill_id) REFERENCES installed_skills(id) ON DELETE CASCADE
);
