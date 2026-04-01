-- Cooking Chef skill tables: recipes, meal plans, shopping lists

CREATE TABLE IF NOT EXISTS recipes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    title           TEXT NOT NULL,
    ingredients     TEXT NOT NULL,           -- JSON array of {name, quantity, unit}
    instructions    TEXT,
    prep_time_min   INTEGER,
    cook_time_min   INTEGER,
    servings        INTEGER DEFAULT 1,
    tags            TEXT,                    -- comma-separated: e.g. 'carnivore,quick,high-protein'
    source          TEXT,                    -- url or 'manual'
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recipes_user ON recipes(user_id);
CREATE INDEX IF NOT EXISTS idx_recipes_tags ON recipes(user_id, tags);

CREATE TABLE IF NOT EXISTS meal_plans (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    date            TEXT NOT NULL,           -- ISO date YYYY-MM-DD
    meal_type       TEXT NOT NULL,           -- breakfast, lunch, dinner, snack
    recipe_id       INTEGER,                -- optional FK to recipes
    title           TEXT NOT NULL,           -- meal description
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, date, meal_type)
);

CREATE INDEX IF NOT EXISTS idx_meal_plans_user ON meal_plans(user_id, date);

CREATE TABLE IF NOT EXISTS shopping_lists (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    week_start      TEXT NOT NULL,           -- ISO date of week start
    items           TEXT NOT NULL DEFAULT '[]',  -- JSON array of {name, quantity, unit, checked}
    status          TEXT NOT NULL DEFAULT 'active',  -- active, completed, exported
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_shopping_user ON shopping_lists(user_id, status);
