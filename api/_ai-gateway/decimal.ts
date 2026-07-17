/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Exact-decimal arithmetic for AI Gateway cost calculations.
 *
 * Token prices (e.g. USD 0.15 per 1,000,000 tokens) are not exactly
 * representable in binary floating point, and naive `number` arithmetic
 * risks tiny rounding artifacts in a financial subsystem. Every value here
 * is represented as a BigInt rational (numerator/denominator) and only
 * converted to a decimal string once, at the very end — never mid-calculation.
 */

export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export const ZERO_RATIONAL: Rational = { num: 0n, den: 1n };

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** Parses a plain decimal string or number (e.g. "0.15", 575) into an exact Rational. */
export function decimalToRational(value: string | number): Rational {
  const str = typeof value === 'number' ? value.toString() : value.trim();
  if (!DECIMAL_STRING_RE.test(str)) {
    throw new Error(`Invalid decimal value for cost calculation: "${str}"`);
  }
  const negative = str.startsWith('-');
  const unsigned = negative ? str.slice(1) : str;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const den = 10n ** BigInt(fracPart.length);
  let num = BigInt((intPart || '0') + fracPart);
  if (negative) num = -num;
  return { num, den };
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  return { num: a.num * b.num, den: a.den * b.den };
}

export function divideRational(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new Error('Division by zero in cost calculation');
  return { num: a.num * b.den, den: a.den * b.num };
}

export function addRational(a: Rational, b: Rational): Rational {
  return { num: a.num * b.den + b.num * a.den, den: a.den * b.den };
}

const OUTPUT_DECIMALS = 12;

/**
 * Formats a Rational as a decimal string with up to `decimals` places.
 * Rounding (half-up) only happens here, on the final truncation — every
 * price used by the gateway today (token counts × power-of-ten prices ÷
 * power-of-ten unit sizes) divides evenly well within this precision, so
 * this is a safety net, not a routine source of imprecision.
 */
export function rationalToDecimalString(r: Rational, decimals = OUTPUT_DECIMALS): string {
  if (r.den === 0n) throw new Error('Invalid rational: zero denominator');
  const negative = (r.num < 0n) !== (r.den < 0n);
  const num = r.num < 0n ? -r.num : r.num;
  const den = r.den < 0n ? -r.den : r.den;

  const scale = 10n ** BigInt(decimals);
  const scaledNum = num * scale;
  let quotient = scaledNum / den;
  const remainder = scaledNum % den;
  if (remainder * 2n >= den) quotient += 1n;

  const digits = quotient.toString().padStart(decimals + 1, '0');
  const intPart = digits.slice(0, digits.length - decimals);
  const fracPart = digits.slice(digits.length - decimals);
  const trimmedFrac = fracPart.replace(/0+$/, '');
  const result = trimmedFrac ? `${intPart}.${trimmedFrac}` : intPart;

  return negative && quotient !== 0n ? `-${result}` : result;
}

/** cost = quantity × pricePerUnit / unitSize, computed exactly, formatted once. */
export function calculateLineCostUsd(
  quantity: number | string,
  pricePerUnit: number | string,
  unitSize: number | string,
): string {
  const q = decimalToRational(quantity);
  const p = decimalToRational(pricePerUnit);
  const u = decimalToRational(unitSize);
  const cost = divideRational(multiplyRational(q, p), u);
  return rationalToDecimalString(cost);
}

/** Sums decimal strings exactly (no intermediate float), formatted once at the end. */
export function sumDecimalStrings(values: string[]): string {
  const total = values.reduce<Rational>((acc, v) => addRational(acc, decimalToRational(v)), ZERO_RATIONAL);
  return rationalToDecimalString(total);
}
