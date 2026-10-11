type Dimension =
  "length" | "mass" | "volume" | "time" | "speed" | "data" | "temperature";
type Unit = {
  dimension: Dimension;
  label: string;
  toBase: (value: number) => number;
  fromBase: (value: number) => number;
};

const linear = (dimension: Dimension, label: string, factor: number): Unit => ({
  dimension,
  label,
  toBase: (value) => value * factor,
  fromBase: (value) => value / factor,
});

const UNITS: Record<string, Unit> = {};
function aliases(unit: Unit, ...names: string[]) {
  for (const name of names) UNITS[name] = unit;
}

aliases(
  linear("length", "millimeter", 0.001),
  "mm",
  "millimeter",
  "millimeters",
  "millimeter",
  "millimeters",
);
aliases(
  linear("length", "centimeter", 0.01),
  "cm",
  "centimeter",
  "centimeters",
  "centimeter",
  "centimeters",
);
aliases(
  linear("length", "meter", 1),
  "m",
  "meter",
  "meters",
  "metre",
  "metres",
);
aliases(
  linear("length", "kilometer", 1000),
  "km",
  "kilometer",
  "kilometers",
  "kilometre",
  "kilometres",
);
aliases(linear("length", "inch", 0.0254), "in", "inch", "inches");
aliases(linear("length", "foot", 0.3048), "ft", "foot", "feet");
aliases(linear("length", "mile", 1609.344), "mi", "mile", "miles");
aliases(linear("mass", "milligram", 0.001), "mg", "milligram", "milligrams");
aliases(linear("mass", "gram", 1), "g", "gram", "grams");
aliases(linear("mass", "kilogram", 1000), "kg", "kilogram", "kilograms");
aliases(linear("mass", "ounce", 28.349523125), "oz", "ounce", "ounces");
aliases(linear("mass", "pound", 453.59237), "lb", "lbs", "pound", "pounds");
aliases(
  linear("volume", "milliliter", 0.001),
  "ml",
  "milliliter",
  "milliliters",
  "millilitre",
  "millilitres",
);
aliases(
  linear("volume", "liter", 1),
  "l",
  "liter",
  "liters",
  "litre",
  "litres",
);
aliases(
  linear("volume", "US gallon", 3.785411784),
  "gal",
  "gallon",
  "gallons",
  "us gallon",
  "us gallons",
);
aliases(
  linear("time", "millisecond", 0.001),
  "ms",
  "millisecond",
  "milliseconds",
);
aliases(linear("time", "second", 1), "s", "sec", "second", "seconds");
aliases(linear("time", "minute", 60), "min", "minute", "minutes");
aliases(linear("time", "hour", 3600), "h", "hr", "hour", "hours");
aliases(linear("time", "day", 86400), "d", "day", "days");
aliases(
  linear("speed", "meter per second", 1),
  "m/s",
  "meter per second",
  "meters per second",
);
aliases(
  linear("speed", "kilometer per hour", 1 / 3.6),
  "km/h",
  "kph",
  "kilometer per hour",
  "kilometers per hour",
);
aliases(
  linear("speed", "mile per hour", 0.44704),
  "mph",
  "mile per hour",
  "miles per hour",
);
aliases(linear("data", "byte", 1), "b", "byte", "bytes");
aliases(linear("data", "kilobyte", 1000), "kb", "kilobyte", "kilobytes");
aliases(linear("data", "megabyte", 1_000_000), "mb", "megabyte", "megabytes");
aliases(
  linear("data", "gigabyte", 1_000_000_000),
  "gb",
  "gigabyte",
  "gigabytes",
);
aliases(
  {
    dimension: "temperature",
    label: "Celsius",
    toBase: (value) => value + 273.15,
    fromBase: (value) => value - 273.15,
  },
  "c",
  "°c",
  "celsius",
  "centigrade",
);
aliases(
  {
    dimension: "temperature",
    label: "Fahrenheit",
    toBase: (value) => ((value - 32) * 5) / 9 + 273.15,
    fromBase: (value) => ((value - 273.15) * 9) / 5 + 32,
  },
  "f",
  "°f",
  "fahrenheit",
);
aliases(linear("temperature", "Kelvin", 1), "k", "kelvin");

const cleanUnit = (value: string) =>
  value
    .toLocaleLowerCase("en-US")
    .replace(/^(?:graden|degrees)\s+/, "")
    .replace(/\s+om$/, "")
    .trim();

/** Strict NL/EN converter for explicit numeric requests; unsupported units stay with normal chat. */
export function directConversion(message: string): {
  value: number;
  unit: string;
} | null {
  const match = message
    .trim()
    .match(
      /^(?:please\s+)?(?:convert|converteer|reken\s+om|hoeveel\s+is|how\s+many|what\s+is|zet)\s+(-?\d+(?:[.,]\d+)?)\s+(.+?)\s+(?:naar|in|to|into)\s+(.+?)[?.!]*$/i,
    );
  if (!match) return null;
  const value = Number(match[1]!.replace(",", "."));
  const from = UNITS[cleanUnit(match[2]!)];
  const to = UNITS[cleanUnit(match[3]!)];
  if (
    !Number.isFinite(value) ||
    !from ||
    !to ||
    from.dimension !== to.dimension
  )
    return null;
  const base = from.toBase(value);
  const result = to.fromBase(base);
  if (!Number.isFinite(result)) return null;
  return { value: Number(result.toPrecision(12)), unit: to.label };
}

export function directConversionReply(
  result: { value: number; unit: string },
  language: "nl" | "en" | undefined,
): string {
  const number = new Intl.NumberFormat(language === "en" ? "en-US" : "nl-NL", {
    maximumFractionDigits: 6,
  }).format(result.value);
  const nlUnits: Record<string, string> = {
    foot: "voet",
    mile: "mijl",
    ounce: "oz",
    pound: "lb",
    millisecond: "milliseconde",
    second: "seconde",
    minute: "minuut",
    hour: "uur",
    day: "dag",
    "meter per second": "meter per seconde",
    "kilometer per hour": "kilometer per uur",
    "mile per hour": "mijl per uur",
  };
  const unit =
    language === "en" ? result.unit : (nlUnits[result.unit] ?? result.unit);
  return `${number} ${unit}.`;
}
