-- Migration 019: Skill Registry Tables
-- installed_skills + skill_submodules + skill_credentials + skill_migrations

-- Installed skills registry
CREATE TABLE IF NOT EXISTS installed_skills (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config JSON NOT NULL DEFAULT '{}',
    installed_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skill submodules (components within a skill)
CREATE TABLE IF NOT EXISTS skill_submodules (
    skill_id TEXT NOT NULL,
    submodule_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config JSON NOT NULL DEFAULT '{}',
    PRIMARY KEY (skill_id, submodule_id),
    FOREIGN KEY (skill_id) REFERENCES installed_skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_submodules_skill ON skill_submodules(skill_id);

-- Encrypted credentials per skill
CREATE TABLE IF NOT EXISTS skill_credentials (
    skill_id TEXT NOT NULL,
    key_name TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    PRIMARY KEY (skill_id, key_name),
    FOREIGN KEY (skill_id) REFERENCES installed_skills(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_credentials_skill ON skill_credentials(skill_id);

-- Migration tracking per skill (skill-level schema evolution)
CREATE TABLE IF NOT EXISTS skill_migrations (
    skill_id TEXT NOT NULL,
    migration_name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (skill_id, migration_name),
    FOREIGN KEY (skill_id) REFERENCES installed_skills(id) ON DELETE CASCADE
);
