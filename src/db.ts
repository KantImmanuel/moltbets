import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'moltbets.db');

// Ensure data directory exists
import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db: InstanceType<typeof Database> = new Database(DB_PATH);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    moltbook_id TEXT UNIQUE NOT NULL,
    moltbook_username TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    balance REAL DEFAULT 10000,
    total_bets INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_losses INTEGER DEFAULT 0,
    total_profit REAL DEFAULT 0,
    current_streak INTEGER DEFAULT 0,
    best_streak INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_bet_at TEXT
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'open',
    open_price REAL,
    close_price REAL,
    result TEXT,
    total_up_bets REAL DEFAULT 0,
    total_down_bets REAL DEFAULT 0,
    up_agent_count INTEGER DEFAULT 0,
    down_agent_count INTEGER DEFAULT 0,
    settled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bets (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    round_id TEXT NOT NULL REFERENCES rounds(id),
    direction TEXT NOT NULL,
    amount REAL NOT NULL,
    result TEXT,
    payout REAL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, round_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- Persistent API keys for self-registered agents
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_id);

  -- Simple analytics
  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    path TEXT,
    ip TEXT,
    user_agent TEXT,
    agent_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics(event);
  CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics(created_at);

  CREATE INDEX IF NOT EXISTS idx_bets_agent ON bets(agent_id);
  CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agents_username ON agents(moltbook_username);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

export default db;
