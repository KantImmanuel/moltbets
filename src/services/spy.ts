export interface SpyQuote {
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  marketState: string;
  timestamp: number;
}

async function fetchYahoo(symbol: string): Promise<any> {
  // Try query2 first (more reliable from cloud), fallback to query1
  const urls = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
  ];
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) { lastError = new Error(`Yahoo Finance error: ${res.status}`); continue; }
      const data: any = await res.json();
      return data.chart.result[0].meta;
    } catch (e: any) {
      lastError = e;
      continue;
    }
  }
  throw lastError || new Error('Failed to fetch SPY data');
}

export async function getSpyQuote(): Promise<SpyQuote> {
  const meta = await fetchYahoo('SPY');
  return {
    price: meta.regularMarketPrice,
    change: meta.regularMarketPrice - meta.chartPreviousClose,
    changePercent: ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100,
    previousClose: meta.chartPreviousClose,
    open: meta.regularMarketOpen || meta.chartPreviousClose,
    high: meta.regularMarketDayHigh || meta.regularMarketPrice,
    low: meta.regularMarketDayLow || meta.regularMarketPrice,
    volume: meta.regularMarketVolume || 0,
    marketState: meta.marketState || 'CLOSED',
    timestamp: Date.now(),
  };
}

export async function getSpyPrice(): Promise<number> {
  const meta = await fetchYahoo('SPY');
  return meta.regularMarketPrice;
}

export async function getSpyOpen(): Promise<number> {
  const meta = await fetchYahoo('SPY');
  return meta.regularMarketOpen || meta.chartPreviousClose;
}
