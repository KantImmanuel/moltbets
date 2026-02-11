import cron from 'node-cron';
import { createDailyRound, settleRound } from './services/settlement';
import db from './db';

const PRICE_MAX_AGE_MS = 5 * 60 * 1000; // Price must be <5 min old

function getLatestPrice(): { price: number; updatedAt: number } | null {
  const kv = db.prepare("SELECT value FROM kv WHERE key = 'spy_price'").get() as any;
  if (!kv) return null;
  return JSON.parse(kv.value);
}

export function startCronJobs(): void {
  // 9:31 AM ET weekdays: create new round, fetch opening price
  cron.schedule('31 9 * * 1-5', async () => {
    console.log('[Cron] Creating daily round...');
    try {
      await createDailyRound();
    } catch (err) {
      console.error('[Cron] Failed to create daily round:', err);
    }
  }, { timezone: 'America/New_York' });

  // 4:30 PM ET weekdays: settle with 30 min buffer after close
  // Retry every 10 sec for up to 30 min (180 attempts)
  cron.schedule('30 16 * * 1-5', async () => {
    console.log('[Cron] Settlement window open (30 min after close). Starting attempts...');
    let settled = false;
    let attempts = 0;
    const maxAttempts = 180;

    const trySettle = async () => {
      if (settled || attempts >= maxAttempts) {
        if (!settled) {
          console.error(`[Cron] SETTLEMENT FAILED after ${attempts} attempts! Manual intervention needed.`);
        }
        return;
      }
      attempts++;

      // Check price freshness
      const latest = getLatestPrice();
      if (!latest || (Date.now() - latest.updatedAt) > PRICE_MAX_AGE_MS) {
        console.log(`[Cron] Settlement attempt ${attempts}: price too stale or missing, retrying...`);
        setTimeout(trySettle, 10000);
        return;
      }

      try {
        const result = await settleRound();
        if (result) {
          console.log(`[Cron] Settlement complete on attempt ${attempts}:`, result);
          settled = true;
        }
      } catch (err: any) {
        console.error(`[Cron] Settlement attempt ${attempts} failed:`, err.message);
        if (attempts < maxAttempts) {
          setTimeout(trySettle, 10000);
        }
      }
    };

    trySettle();
  }, { timezone: 'America/New_York' });

  console.log('[Cron] Scheduled: round creation 9:31 AM ET, settlement 4:30 PM ET (30 min buffer) weekdays');
}
