-- Reaction Radar topic pillars — moves the hardcoded PILLAR_KEYWORDS
-- object from src/agents/reaction-radar-agent.ts into a DB table so
-- the admin portal can add/edit/remove pillars without recompilation.
--
-- Seeded with the 6 original pillars (politics, economics, fitness,
-- faith, selfdev, geopolitics) and their Portuguese keyword arrays.
-- The reaction-radar-agent will be modified to read from this table
-- instead of the hardcoded object in Phase 3 (config migration).

CREATE TABLE IF NOT EXISTS config_pillars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  weight REAL NOT NULL DEFAULT 1.0,
  language TEXT NOT NULL DEFAULT 'pt-BR',
  user_id INTEGER NOT NULL DEFAULT 0,   -- 0 = global, >0 = per-user
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(name, user_id)
);

CREATE INDEX IF NOT EXISTS idx_config_pillars_user ON config_pillars(user_id, enabled);

-- Seed with the original 6 hardcoded pillars (global, all users)
INSERT OR IGNORE INTO config_pillars (name, keywords, language) VALUES
  ('politics', '["política","governo","lula","bolsonaro","esquerda","direita","estado","imposto","congresso","stf","regulação","censura","liberdade"]', 'pt-BR'),
  ('economics', '["economia","inflação","dólar","real","mercado","juros","selic","pib","recessão","investimento","cripto","bitcoin","banco central"]', 'pt-BR'),
  ('fitness', '["treino","musculação","corrida","maratona","dieta","suplemento","academia","crossfit","hipertrofia","atleta"]', 'pt-BR'),
  ('faith', '["cristão","igreja","bíblia","fé","deus","família","valores","casamento","masculinidade"]', 'pt-BR'),
  ('selfdev', '["disciplina","hábito","produtividade","mentalidade","sucesso","foco","propósito","estoicismo"]', 'pt-BR'),
  ('geopolitics', '["guerra","china","eua","trump","brics","otan","israel","irã","ucrânia","rússia","petróleo"]', 'pt-BR');
