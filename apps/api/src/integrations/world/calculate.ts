/* A small arithmetic parser, so the model never needs eval for sums. */

const FUNCTIONS: Record<string, (value: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

const isFunction = (token: string) => Object.hasOwn(FUNCTIONS, token);

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  const source = String(expression)
    .replace(/,/g, ".")
    .replace(/×/g, "*")
    .replace(/÷/g, "/");
  const lower = source.toLowerCase();
  const pattern =
    /\s*(\d+(?:\.\d+)?|sqrt|abs|round|floor|ceil|procent|percent|van|of|[-+*/^%()])/gy;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(lower))) {
    const token = match[1] as string;
    // "15 procent van 240" is 15% * 240; "van" and "of" multiply.
    tokens.push(
      /^(?:procent|percent)$/.test(token)
        ? "%"
        : /^(?:van|of)$/.test(token)
          ? "*"
          : token,
    );
    consumed = pattern.lastIndex;
  }
  if (source.slice(consumed).trim())
    throw new Error("Unsupported characters in expression");
  return tokens;
}

export function calculate(expression: string): number {
  const tokens = tokenize(expression);
  let position = 0;
  const peek = () => tokens[position];

  function primary(): number {
    const token = tokens[position++];
    if (token === undefined) throw new Error("Unexpected end of expression");
    if (token === "(") {
      const value = additive();
      if (tokens[position++] !== ")")
        throw new Error("Missing closing parenthesis");
      return value;
    }
    if (isFunction(token)) {
      if (tokens[position++] !== "(")
        throw new Error(`${token} needs parentheses`);
      const value = additive();
      if (tokens[position++] !== ")")
        throw new Error("Missing closing parenthesis");
      return (FUNCTIONS[token] as (value: number) => number)(value);
    }
    if (token === "-") return -power();
    if (token === "+") return power();
    if (/^\d/.test(token)) return Number(token);
    throw new Error(`Unexpected ${token}`);
  }
  // A "%" with nothing to operate on after it is a percentage; "10 % 3" stays a remainder.
  const startsOperand = (token: string | undefined) =>
    token !== undefined &&
    (/^\d/.test(token) || token === "(" || isFunction(token) || token === "-");
  function power(): number {
    let base = primary();
    if (peek() === "%" && !startsOperand(tokens[position + 1])) {
      position++;
      base /= 100;
    }
    if (peek() === "^") {
      position++;
      return base ** power();
    }
    return base;
  }
  function multiplicative(): number {
    let value = power();
    while (["*", "/", "%"].includes(peek() as string)) {
      const operator = tokens[position++];
      const right = power();
      if (operator !== "*" && right === 0) throw new Error("Division by zero");
      value =
        operator === "*"
          ? value * right
          : operator === "/"
            ? value / right
            : value % right;
    }
    return value;
  }
  function additive(): number {
    let value = multiplicative();
    while (["+", "-"].includes(peek() as string))
      value =
        tokens[position++] === "+"
          ? value + multiplicative()
          : value - multiplicative();
    return value;
  }
  const value = additive();
  if (position !== tokens.length) throw new Error("Unexpected trailing input");
  if (!Number.isFinite(value)) throw new Error("Result is not a finite number");
  return Number(value.toPrecision(14));
}
