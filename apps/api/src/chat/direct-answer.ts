import {
  directCalculation,
  directCalculationReply,
} from "./direct-calculation.js";
import {
  directConversion,
  directConversionReply,
} from "./direct-conversion.js";

/** Strict no-model answers for small, explicit calculations and unit conversions. */
export function directAnswer(
  message: string,
  language: "nl" | "en" | undefined,
): string | null {
  const conversion = directConversion(message);
  if (conversion) return directConversionReply(conversion, language);
  const value = directCalculation(message);
  return value === null ? null : directCalculationReply(value, language);
}
