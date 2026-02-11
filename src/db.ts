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

// --- Migrations ---
// Add mode/wallet/tx columns for real money support
const migrations = [
  {
    name: 'bets_mode',
    sql: `ALTER TABLE bets ADD COLUMN mode TEXT DEFAULT 'play'`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(bets)").all() as any[];
      return cols.some((c: any) => c.name === 'mode');
    }
  },
  {
    name: 'bets_tx_hash',
    sql: `ALTER TABLE bets ADD COLUMN tx_hash TEXT`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(bets)").all() as any[];
      return cols.some((c: any) => c.name === 'tx_hash');
    }
  },
  {
    name: 'bets_wallet_address',
    sql: `ALTER TABLE bets ADD COLUMN wallet_address TEXT`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(bets)").all() as any[];
      return cols.some((c: any) => c.name === 'wallet_address');
    }
  },
  {
    name: 'agents_wallet_address',
    sql: `ALTER TABLE agents ADD COLUMN wallet_address TEXT`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(agents)").all() as any[];
      return cols.some((c: any) => c.name === 'wallet_address');
    }
  },
  {
    name: 'agents_real_profit',
    sql: `ALTER TABLE agents ADD COLUMN real_total_bets INTEGER DEFAULT 0`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(agents)").all() as any[];
      return cols.some((c: any) => c.name === 'real_total_bets');
    }
  },
  {
    name: 'agents_real_wins',
    sql: `ALTER TABLE agents ADD COLUMN real_total_wins INTEGER DEFAULT 0`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(agents)").all() as any[];
      return cols.some((c: any) => c.name === 'real_total_wins');
    }
  },
  {
    name: 'agents_real_losses',
    sql: `ALTER TABLE agents ADD COLUMN real_total_losses INTEGER DEFAULT 0`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(agents)").all() as any[];
      return cols.some((c: any) => c.name === 'real_total_losses');
    }
  },
  {
    name: 'agents_real_total_profit',
    sql: `ALTER TABLE agents ADD COLUMN real_total_profit REAL DEFAULT 0`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(agents)").all() as any[];
      return cols.some((c: any) => c.name === 'real_total_profit');
    }
  },
  {
    name: 'rounds_open_tx',
    sql: `ALTER TABLE rounds ADD COLUMN open_tx TEXT`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(rounds)").all() as any[];
      return cols.some((c: any) => c.name === 'open_tx');
    }
  },
  {
    name: 'rounds_settle_tx',
    sql: `ALTER TABLE rounds ADD COLUMN settle_tx TEXT`,
    check: () => {
      const cols = db.prepare("PRAGMA table_info(rounds)").all() as any[];
      return cols.some((c: any) => c.name === 'settle_tx');
    }
  },
  {
    name: 'idx_bets_mode',
    sql: `CREATE INDEX IF NOT EXISTS idx_bets_mode ON bets(mode)`,
    check: () => true // CREATE IF NOT EXISTS handles idempotency
  },
];

for (const m of migrations) {
  if (!m.check()) {
    try {
      db.exec(m.sql);
      console.log(`[DB] Migration applied: ${m.name}`);
    } catch (err: any) {
      // Ignore "duplicate column" errors from concurrent starts
      if (!err.message.includes('duplicate column')) {
        console.error(`[DB] Migration failed (${m.name}):`, err.message);
      }
    }
  }
}

export default db;
