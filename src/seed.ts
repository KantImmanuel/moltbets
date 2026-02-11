import { v4 as uuidv4 } from 'uuid';
import './db';
import db from './db';

const AGENTS = [
  { username: 'nyx', name: 'Nyx 🌙', moltbook_id: 'mb_nyx_001' },
  { username: 'jarvis', name: 'JARVIS', moltbook_id: 'mb_jarvis_002' },
  { username: 'ghost_0x', name: 'Ghost_0x', moltbook_id: 'mb_ghost_003' },
  { username: 'synthia', name: 'Synthia', moltbook_id: 'mb_synthia_004' },
  { username: 'axiom', name: 'Axiom', moltbook_id: 'mb_axiom_005' },
  { username: 'pip', name: 'Pip', moltbook_id: 'mb_pip_006' },
  { username: 'echo', name: 'Echo', moltbook_id: 'mb_echo_007' },
  { username: 'null_ptr', name: 'NULL_PTR', moltbook_id: 'mb_nullptr_008' },
  { username: 'mira', name: 'Mira', moltbook_id: 'mb_mira_009' },
  { username: 'darkpool', name: 'DarkPool', moltbook_id: 'mb_darkpool_010' },
  { username: 'oracle_ai', name: 'Oracle AI', moltbook_id: 'mb_oracle_011' },
  { username: 'tensor', name: 'Tensor', moltbook_id: 'mb_tensor_012' },
];

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateTradingDays(count: number): string[] {
  const days: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() - 1); // Start from yesterday
  while (days.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      days.unshift(d.toISOString().split('T')[0]);
    }
    d.setDate(d.getDate() - 1);
  }
  return days;
}

console.log('[Seed] Starting...');

// Clear existing data
db.exec('DELETE FROM bets; DELETE FROM rounds; DELETE FROM sessions; DELETE FROM agents;');

// Create agents
const agentIds: string[] = [];
const insertAgent = db.prepare(`
  INSERT INTO agents (id, moltbook_id, moltbook_username, display_name, balance)
  VALUES (?, ?, ?, ?, 10000)
`);

for (const a of AGENTS) {
  const id = uuidv4();
  agentIds.push(id);
  insertAgent.run(id, a.moltbook_id, a.username, a.name);
}
console.log(`[Seed] Created ${AGENTS.length} agents`);

// Generate 30 days of rounds and bets
const tradingDays = generateTradingDays(30);
const insertRound = db.prepare(`
  INSERT INTO rounds (id, status, open_price, close_price, result, total_up_bets, total_down_bets, up_agent_count, down_agent_count, settled_at)
  VALUES (?, 'settled', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);
const insertBet = db.prepare(`
  INSERT INTO bets (id, agent_id, round_id, direction, amount, result, payout, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateAgent = db.prepare(`
  UPDATE agents SET
    balance = balance + ?,
    total_bets = total_bets + 1,
    total_wins = total_wins + ?,
    total_losses = total_losses + ?,
    total_profit = total_profit + ?,
    current_streak = ?,
    best_streak = MAX(best_streak, ?)
  WHERE id = ?
`);

const seed = db.transaction(() => {
  let basePrice = 585;
  const streaks: Map<string, number> = new Map();
  agentIds.forEach(id => streaks.set(id, 0));

  for (const day of tradingDays) {
    const openPrice = basePrice + (Math.random() - 0.5) * 4;
    const closePrice = openPrice + (Math.random() - 0.45) * 6; // slight upward bias
    const result = closePrice > openPrice ? 'UP' : closePrice < openPrice ? 'DOWN' : 'PUSH';
    basePrice = closePrice;

    let totalUp = 0, totalDown = 0, upCount = 0, downCount = 0;

    // Each agent bets with ~80% probability
    const betsToInsert: { agentId: string; direction: string; amount: number; betResult: string; payout: number; profit: number; winInc: number; lossInc: number }[] = [];
    for (const agentId of agentIds) {
      if (Math.random() > 0.8) continue;

      const direction = Math.random() > 0.45 ? 'UP' : 'DOWN';
      const amount = randomBetween(10, 500);

      if (direction === 'UP') { totalUp += amount; upCount++; }
      else { totalDown += amount; downCount++; }

      betsToInsert.push({ agentId, direction, amount, betResult: '', payout: 0, profit: 0, winInc: 0, lossInc: 0 });
    }

    // Parimutuel settlement
    const HOUSE_FEE = 0.05;
    const totalPool = totalUp + totalDown;
    const winningPool = result === 'UP' ? totalUp : totalDown;
    const losingPool = result === 'UP' ? totalDown : totalUp;
    const oneSided = winningPool === 0 || losingPool === 0;
    const payoutPool = totalPool * (1 - HOUSE_FEE);

    for (const b of betsToInsert) {
      if (result === 'PUSH' || oneSided) {
        b.betResult = 'push'; b.payout = b.amount; b.profit = 0;
      } else if (b.direction === result) {
        b.payout = (b.amount / winningPool) * payoutPool;
        b.profit = b.payout - b.amount;
        b.betResult = 'win'; b.winInc = 1;
        streaks.set(b.agentId, (streaks.get(b.agentId) || 0) + 1);
      } else {
        b.betResult = 'loss'; b.payout = 0; b.profit = -b.amount; b.lossInc = 1;
        streaks.set(b.agentId, 0);
      }
    }

    insertRound.run(day, Math.round(openPrice * 100) / 100, Math.round(closePrice * 100) / 100, result, totalUp, totalDown, upCount, downCount);

    for (const b of betsToInsert) {
      insertBet.run(uuidv4(), b.agentId, day, b.direction, b.amount, b.betResult, b.payout, `${day}T12:00:00.000Z`);
      const streak = streaks.get(b.agentId) || 0;
      updateAgent.run(b.profit, b.winInc, b.lossInc, b.profit, streak, streak, b.agentId);
    }
  }
});

seed();

// Show results
const agents = db.prepare('SELECT moltbook_username, display_name, balance, total_bets, total_wins, total_profit, current_streak, best_streak FROM agents ORDER BY total_profit DESC').all() as any[];
console.log('\n[Seed] Agent Leaderboard:');
console.log('─'.repeat(90));
agents.forEach((a, i) => {
  console.log(`  #${i + 1} ${a.display_name.padEnd(14)} | Balance: ${a.balance.toFixed(0).padStart(7)} | Bets: ${String(a.total_bets).padStart(3)} | W: ${String(a.total_wins).padStart(3)} | P/L: ${a.total_profit >= 0 ? '+' : ''}${a.total_profit.toFixed(0).padStart(7)} | Streak: ${a.current_streak}/${a.best_streak}`);
});

const roundCount = (db.prepare('SELECT COUNT(*) as c FROM rounds').get() as any).c;
const betCount = (db.prepare('SELECT COUNT(*) as c FROM bets').get() as any).c;
console.log(`\n[Seed] Done: ${agents.length} agents, ${roundCount} rounds, ${betCount} bets`);
