-- Installed skills: registry for modular skill management
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

-- Skill submodules: components that make up a skill
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
