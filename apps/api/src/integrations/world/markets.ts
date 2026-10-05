import type { MarketRate, MarketRates } from "@nova/contracts";
import type { WorldHttp } from "./world.types.js";

const round1 = (value: number) => Math.round(value * 10) / 10;

interface FxSeries {
  rates?: Record<string, Record<string, number> | undefined>;
}
interface CoinPrice {
  bitcoin?: { eur?: number; eur_24h_change?: number };
}

export async function markets(
  http: WorldHttp,
  signal?: AbortSignal,
): Promise<MarketRates> {
  const start = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
  const [fx, coin] = await Promise.allSettled([
    http.getJson<FxSeries>(
      `https://api.frankfurter.dev/v1/${start}..?base=EUR&symbols=USD,GBP`,
      signal,
    ),
    http.getJson<CoinPrice>(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur&include_24hr_change=true",
      signal,
    ),
  ]);
  const eur: Record<string, MarketRate> = {};
  let date: string | null = null;
  if (fx.status === "fulfilled" && fx.value?.rates) {
    const days = Object.keys(fx.value.rates).sort();
    const last = days.at(-1);
    const before = days.at(-2);
    date = last ?? null;
    for (const code of ["USD", "GBP"]) {
      const now = last ? fx.value.rates[last]?.[code] : undefined;
      const then = before ? fx.value.rates[before]?.[code] : undefined;
      if (typeof now !== "number") continue;
      eur[code] = {
        rate: now,
        changePercent:
          typeof then === "number"
            ? Math.round(((now - then) / then) * 1000) / 10
            : null,
      };
    }
  }
  const btc = coin.status === "fulfilled" ? coin.value?.bitcoin : null;
  const bitcoin =
    typeof btc?.eur === "number"
      ? {
          eur: Math.round(btc.eur),
          change24hPercent:
            typeof btc.eur_24h_change === "number"
              ? round1(btc.eur_24h_change)
              : null,
        }
      : null;
  if (!Object.keys(eur).length && !bitcoin)
    throw new Error("Geen koersen beschikbaar");
  return {
    date,
    eur,
    bitcoin,
    source: "Europese Centrale Bank en CoinGecko",
  };
}

export interface Conversion {
  amount: number;
  from: string;
  to: string;
  rate: number;
  converted: number;
  date?: string;
  source?: string;
}

export async function convertCurrency(
  http: WorldHttp,
  amount: number,
  fromCode: string,
  toCode: string,
  signal?: AbortSignal,
): Promise<Conversion> {
  const from = fromCode.toUpperCase();
  const to = toCode.toUpperCase();
  if (from === to) return { amount, from, to, converted: amount, rate: 1 };
  const data = await http.getJson<{
    date?: string;
    rates?: Record<string, number>;
  }>(
    `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`,
    signal,
  );
  const rate = data?.rates?.[to];
  if (typeof rate !== "number")
    throw new Error(`Onbekende valuta: ${from} of ${to}`);
  return {
    amount,
    from,
    to,
    rate,
    converted: Math.round(amount * rate * 100) / 100,
    date: data.date,
    source: "Europese Centrale Bank",
  };
}
