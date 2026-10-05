/** Where something is on earth, as the world tools and the dashboard describe it. */
export interface WorldPlace {
  name: string;
  region: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  timezone?: string;
}

export interface WeatherHour {
  time: string;
  temperature: number;
  rainChancePercent: number | null;
  condition: string;
}

export interface WeatherDay {
  date: string;
  weekday: string;
  min: number;
  max: number;
  rainChancePercent: number | null;
  rainMm: number;
  condition: string;
  sunrise?: string;
  sunset?: string;
}

export interface WeatherForecast {
  location: WorldPlace;
  summary: { nu: string; dagen: string[] };
  current: {
    temperature: number;
    feelsLike: number;
    humidityPercent: number;
    windKmh: number;
    gustsKmh: number;
    rainMm: number;
    condition: string;
    isDay: boolean;
  };
  days: WeatherDay[];
  nextHours: WeatherHour[];
  source: string;
  hint: string;
}

export interface AirLevel {
  value: number | null;
  label: string | null;
}

export interface PollenReading {
  name: string;
  perM3: number;
  label: string | null;
}

export interface AirQuality {
  location: string;
  aqi: AirLevel;
  pm25: number | null;
  pm10: number | null;
  uv: AirLevel;
  pollen: { highest: PollenReading | null; all: PollenReading[] };
  summary: string;
  source: string;
  hint: string;
}

export interface MarketRate {
  rate: number;
  changePercent: number | null;
}

export interface MarketRates {
  date: string | null;
  eur: Record<string, MarketRate>;
  bitcoin: { eur: number; change24hPercent: number | null } | null;
  source: string;
}

export interface IssPosition {
  latitude: number;
  longitude: number;
  altitudeKm: number;
  speedKmh: number;
  visibility: string;
  distanceFromHomeKm: number | null;
  inRangeOfHome: boolean;
  source: string;
  hint: string;
}

export interface MoonPhase {
  name: string;
  fraction: number;
  illuminationPercent: number;
  waxing: boolean;
  nextFull: string;
  nextNew: string;
}

export interface NewsItem {
  title: string;
  summary: string;
  link: string;
  published: string;
}

export interface NewsHeadlines {
  source: string;
  topic: string;
  items: NewsItem[];
  hint: string;
}
