export type MarketState = 'pre-market' | 'live' | 'settling' | 'closed' | 'weekend';

export function getMarketState(): { state: MarketState; nextEvent: string; nextEventTime: number } {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const hours = et.getHours();
  const minutes = et.getMinutes();
  const timeMinutes = hours * 60 + minutes;

  const MARKET_OPEN = 9 * 60 + 30;   // 9:30 AM ET
  const MARKET_CLOSE = 16 * 60;       // 4:00 PM ET
  const SETTLE_TIME = 16 * 60 + 35;   // 4:35 PM ET

  // Weekend
  if (day === 0 || day === 6) {
    const daysUntilMonday = day === 0 ? 1 : 2;
    const monday = new Date(et);
    monday.setDate(monday.getDate() + daysUntilMonday);
    monday.setHours(9, 30, 0, 0);
    return { state: 'weekend', nextEvent: 'Market opens', nextEventTime: monday.getTime() };
  }

  // Pre-market (before 9:30 AM)
  if (timeMinutes < MARKET_OPEN) {
    const openTime = new Date(et);
    openTime.setHours(9, 30, 0, 0);
    return { state: 'pre-market', nextEvent: 'Market opens', nextEventTime: openTime.getTime() };
  }

  // Live (9:30 AM - 4:00 PM)
  if (timeMinutes < MARKET_CLOSE) {
    const closeTime = new Date(et);
    closeTime.setHours(16, 0, 0, 0);
    return { state: 'live', nextEvent: 'Market closes', nextEventTime: closeTime.getTime() };
  }

  // Settling (4:00 PM - 4:35 PM)
  if (timeMinutes < SETTLE_TIME) {
    const settleTime = new Date(et);
    settleTime.setHours(16, 35, 0, 0);
    return { state: 'settling', nextEvent: 'Settlement complete', nextEventTime: settleTime.getTime() };
  }

  // After hours
  const tomorrow = new Date(et);
  tomorrow.setDate(tomorrow.getDate() + (day === 5 ? 3 : 1));
  tomorrow.setHours(9, 30, 0, 0);
  return { state: 'closed', nextEvent: 'Market opens', nextEventTime: tomorrow.getTime() };
}

export function getTodayRoundId(): string {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return et.toISOString().split('T')[0];
}

export function isBettingOpen(): boolean {
  const { state } = getMarketState();
  return state === 'live';
}
