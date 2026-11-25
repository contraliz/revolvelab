/*
 * A small, safe expression engine for Desmos-style input.
 *
 * It intentionally mirrors the parts of Desmos the studio needs:
 *   - arithmetic and implicit multiplication: 2x, x(x+1), 2 sin(x)
 *   - constants: pi, tau, e, infinity
 *   - functions: sqrt, sin, ln, log (base 10), abs, min, max, ...
 *   - comparisons and logical operators: < <= > >= = !=, and, or, not
 *   - chained comparisons: 0 <= x <= 2
 *   - restrictions and piecewises: x^2 {0 <= x <= 2},
 *     {x < 0: -x, x >= 0: x^2}
 *
 * No eval, no Function constructor, and no network access.
 */

const CONSTANTS = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

const LOGICAL_WORDS = new Set(["and", "or", "not"]);

const FUNCTIONS = {
  abs: Math.abs,
  acos: Math.acos,
  acosh: Math.acosh,
  acot: (x) => Math.PI / 2 - Math.atan(x),
  acoth: (x) => 0.5 * Math.log((x + 1) / (x - 1)),
  acsc: (x) => Math.asin(1 / x),
  acsch: (x) => Math.asinh(1 / x),
  asec: (x) => Math.acos(1 / x),
  asech: (x) => Math.acosh(1 / x),
  asin: Math.asin,
  asinh: Math.asinh,
  atan: Math.atan,
  atanh: Math.atanh,
  cbrt: Math.cbrt,
  ceil: Math.ceil,
  cos: Math.cos,
  cosh: Math.cosh,
  cot: (x) => 1 / Math.tan(x),
  coth: (x) => 1 / Math.tanh(x),
  csc: (x) => 1 / Math.sin(x),
  csch: (x) => 1 / Math.sinh(x),
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  sec: (x) => 1 / Math.cos(x),
  sech: (x) => 1 / Math.cosh(x),
  sign: Math.sign,
  sin: Math.sin,
  sinh: Math.sinh,
  sqrt: Math.sqrt,
  tan: Math.tan,
  tanh: Math.tanh,
  trunc: Math.trunc,
};

const MULTI_FUNCTIONS = {
  atan2: (a, b) => Math.atan2(a, b),
  max: (...values) => Math.max(...values),
  min: (...values) => Math.min(...values),
  mod: (a, b) => a % b,
  nthroot: (n, x) => {
    if (n === 0) return NaN;
    if (x < 0 && Math.abs(n % 2) === 1) {
      return -Math.pow(-x, 1 / n);
    }
    return Math.pow(x, 1 / n);
  },
  pow: (a, b) => Math.pow(a, b),
  round: (x, digits = 0) => {
    const scale = Math.pow(10, digits);
    return Math.round(x * scale) / scale;
  },
};

const ALIASES = {
  arcsin: "asin",
  arccos: "acos",
  arctan: "atan",
  arccot: "acot",
  arcsec: "asec",
  arccsc: "acsc",
  arcsinh: "asinh",
  arccosh: "acosh",
  arctanh: "atanh",
};

const SUPERSCRIPTS = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁻": "-",
};

export function normalizeExpression(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";

  text = text
    .replace(/[−–—]/g, "-")
    .replace(/[×·⋅∙]/g, "*")
    .replace(/÷/g, "/")
    .replace(/π/g, "pi")
    .replace(/τ/g, "tau")
    .replace(/∞/g, "infinity")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/√\s*\(/g, "sqrt(")
    .replace(/√\s*([a-zA-Z0-9.]+)/g, "sqrt($1)")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, (run) =>
      "^" + [...run].map((character) => SUPERSCRIPTS[character]).join(""),
    )
    .replace(/\*\*/g, "^")
    .replace(/\bMath\./g, "")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

/** Remove a leading y =, f(x) =, or similar label from a function line. */
export function stripFunctionPrefix(value) {
  return String(value ?? "")
    .replace(/^\s*y\s*=\s*/i, "")
    .replace(/^\s*f\s*\(\s*x\s*\)\s*=\s*/i, "")
    .replace(/^\s*[a-z]\s*\(\s*x\s*\)\s*=\s*/i, "")
    .trim();
}

class Tokenizer {
  constructor(source) {
    this.source = source;
    this.tokens = [];
    this.tokenize();
    this.position = 0;
  }

  tokenize() {
    const source = this.source;
    let index = 0;

    while (index < source.length) {
      const character = source[index];
      if (/\s/.test(character)) {
        index += 1;
        continue;
      }

      if (/[0-9.]/.test(character)) {
        const match = source
          .slice(index)
          .match(/^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
        if (!match) {
          throw new Error(`Invalid number near "${source.slice(index, index + 8)}".`);
        }
        this.tokens.push({
          type: "number",
          value: Number(match[0]),
          index,
        });
        index += match[0].length;
        continue;
      }

      if (/[a-zA-Z]/.test(character)) {
        const match = source.slice(index).match(/^[a-zA-Z][a-zA-Z0-9_]*/);
        const raw = match[0];
        this.tokens.push({
          type: "identifier",
          value: raw,
          name: raw.toLowerCase(),
          index,
        });
        index += raw.length;
        continue;
      }

      const pair = source.slice(index, index + 2);
      if (pair === "<=" || pair === ">=" || pair === "!=") {
        this.tokens.push({ type: "operator", value: pair, index });
        index += 2;
        continue;
      }

      if ("+-*/^(),{}[]:|<>=".includes(character)) {
        this.tokens.push({
          type: character === "=" ? "operator" : "operator",
          value: character,
          index,
        });
        index += 1;
        continue;
      }

      throw new Error(`Unexpected character "${character}".`);
    }

    this.tokens.push({ type: "eof", value: "", index });
  }

  peek() {
    return this.tokens[this.position];
  }

  consume(value) {
    const token = this.peek();
    if (token.value !== value) return null;
    this.position += 1;
    return token;
  }

  expect(value, label) {
    const token = this.consume(value);
    if (!token) {
      const found = this.peek();
      throw new Error(
        `Expected ${label || `"${value}"`} near "${
          this.source.slice(Math.max(0, found.index - 1), found.index + 9) || "end of input"
        }".`,
      );
    }
    return token;
  }
}

class Parser {
  constructor(source, options = {}) {
    this.source = source;
    this.allowVariable = options.allowVariable !== false;
    this.absDepth = 0;
    this.tokens = new Tokenizer(source);
  }

  parse() {
    const ast = this.parseOr();
    if (this.tokens.peek().type !== "eof") {
      const token = this.tokens.peek();
      throw new Error(`Unexpected "${token.value}" at position ${token.index + 1}.`);
    }
    return ast;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isWord("or")) {
      this.tokens.position += 1;
      left = {
        type: "logical",
        op: "or",
        left,
        right: this.parseAnd(),
      };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.isWord("and")) {
      this.tokens.position += 1;
      left = {
        type: "logical",
        op: "and",
        left,
        right: this.parseNot(),
      };
    }
    return left;
  }

  parseNot() {
    if (this.isWord("not")) {
      this.tokens.position += 1;
      return { type: "logical", op: "not", value: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parseAdditive();
    const comparisons = [];

    while (this.isComparisonOperator(this.tokens.peek().value)) {
      const operator = this.tokens.peek().value;
      this.tokens.position += 1;
      const right = this.parseAdditive();
      comparisons.push({ type: "compare", op: operator, left, right });
      left = right;
    }

    if (comparisons.length === 0) return left;
    if (comparisons.length === 1) return comparisons[0];
    return comparisons.reduce((combined, comparison) => ({
      type: "logical",
      op: "and",
      left: combined,
      right: comparison,
    }));
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (true) {
      if (this.tokens.consume("+")) {
        left = {
          type: "binary",
          op: "+",
          left,
          right: this.parseMultiplicative(),
        };
      } else if (this.tokens.consume("-")) {
        left = {
          type: "binary",
          op: "-",
          left,
          right: this.parseMultiplicative(),
        };
      } else {
        break;
      }
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (true) {
      if (this.tokens.consume("*")) {
        left = {
          type: "binary",
          op: "*",
          left,
          right: this.parseUnary(),
        };
      } else if (this.tokens.consume("/")) {
        left = {
          type: "binary",
          op: "/",
          left,
          right: this.parseUnary(),
        };
      } else if (this.startsImplicitFactor()) {
        left = {
          type: "binary",
          op: "*",
          left,
          right: this.parseUnary(),
        };
      } else {
        break;
      }
    }
    return left;
  }

  startsImplicitFactor() {
    const token = this.tokens.peek();
    if (token.type === "number") return true;
    if (token.type === "identifier") {
      return !LOGICAL_WORDS.has(token.name);
    }
    if (token.value === "|") return this.absDepth === 0;
    return token.value === "(" || token.value === "{";
  }

  parseUnary() {
    if (this.tokens.consume("+")) return this.parseUnary();
    if (this.tokens.consume("-")) {
      return { type: "unary", op: "-", value: this.parseUnary() };
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    if (this.tokens.consume("^")) {
      return {
        type: "binary",
        op: "^",
        left: base,
        right: this.parseUnary(),
      };
    }
    return base;
  }

  parsePrimary() {
    const token = this.tokens.peek();

    if (token.type === "number") {
      this.tokens.position += 1;
      return { type: "number", value: token.value };
    }

    if (token.type === "identifier") {
      this.tokens.position += 1;
      const rawName = token.value;
      let name = token.name;
      if (name in ALIASES) name = ALIASES[name];

      if (this.tokens.peek().value === "(") {
        if (name in FUNCTIONS || name in MULTI_FUNCTIONS) {
          this.tokens.position += 1;
          const args = [];
          if (this.tokens.peek().value !== ")") {
            args.push(this.parseOr());
            while (this.tokens.consume(",")) {
              args.push(this.parseOr());
            }
          }
          this.tokens.expect(")", "closing )");
          if (name in MULTI_FUNCTIONS) {
            if (args.length < 2) {
              throw new Error(`Function "${rawName}" needs at least two arguments.`);
            }
          } else if (args.length !== 1) {
            throw new Error(`Function "${rawName}" needs exactly one argument.`);
          }
          return { type: "call", name, args };
        }

        if (
          !(name in CONSTANTS) &&
          name !== "x" &&
          name !== "y" &&
          name !== "infinity"
        ) {
          throw new Error(`Unknown function "${rawName}".`);
        }
      }

      if (name in CONSTANTS) {
        return { type: "number", value: CONSTANTS[name] };
      }

      if (name === "x") {
        if (!this.allowVariable) {
          throw new Error("The variable x is not allowed here.");
        }
        return { type: "variable", name: "x" };
      }

      if (name === "y") {
        return { type: "variable", name: "y" };
      }

      if (name === "infinity") {
        return { type: "number", value: Infinity };
      }

      if (name === "true") return { type: "boolean", value: true };
      if (name === "false") return { type: "boolean", value: false };

      throw new Error(`Unknown symbol "${rawName}". Use x as the variable.`);
    }

    if (this.tokens.consume("(")) {
      const value = this.parseOr();
      this.tokens.expect(")", "closing )");
      return value;
    }

    if (this.tokens.consume("{")) {
      return this.parseBraces();
    }

    if (this.tokens.consume("|")) {
      this.absDepth += 1;
      const value = this.parseOr();
      this.absDepth -= 1;
      this.tokens.expect("|", "closing |");
      return { type: "call", name: "abs", args: [value] };
    }

    throw new Error(
      `Unexpected token "${token.value || "end of input"}" near position ${
        token.index + 1
      }.`,
    );
  }

  parseBraces() {
    const items = [];
    if (this.tokens.peek().value === "}") {
      throw new Error("Empty braces are not a valid restriction.");
    }

    while (this.tokens.peek().type !== "eof") {
      const expression = this.parseOr();
      if (this.tokens.consume(":")) {
        const value = this.parseOr();
        items.push({ condition: expression, value });
      } else {
        items.push({ condition: null, value: expression });
      }
      if (!this.tokens.consume(",")) break;
    }
    this.tokens.expect("}", "closing }");

    const branches = items.filter((item) => item.condition);
    if (branches.length > 0) {
      const fallbackEntry = [...items]
        .reverse()
        .find((item) => !item.condition);
      return {
        type: "piecewise",
        branches,
        fallback: fallbackEntry ? fallbackEntry.value : null,
      };
    }

    // A lone boolean expression is Desmos' domain-restriction shorthand.
    if (items.length === 1) {
      const item = items[0];
      if (isBooleanNode(item.value)) {
        return { type: "restriction", condition: item.value };
      }
      return item.value;
    }

    // {condition, condition} is unusual in Desmos; intersect the conditions.
    const condition = items.reduce((combined, item) => ({
      type: "logical",
      op: "and",
      left: combined,
      right: item.value,
    }));
    return { type: "restriction", condition };
  }

  isWord(word) {
    const token = this.tokens.peek();
    return token.type === "identifier" && token.name === word;
  }

  isComparisonOperator(value) {
    return value === "<" || value === ">" || value === "<=" || value === ">=" ||
      value === "=" || value === "!=";
  }
}

function isBooleanNode(node) {
  if (!node) return false;
  if (node.type === "compare" || node.type === "logical") return true;
  if (node.type === "boolean") return true;
  return false;
}

function truthy(value) {
  if (typeof value === "boolean") return value;
  if (Number.isNaN(value)) return false;
  return Boolean(value);
}

function compareValues(left, right, operator) {
  const tolerance = 1e-10 * Math.max(1, Math.abs(left), Math.abs(right));
  switch (operator) {
    case "<":
      return left < right;
    case ">":
      return left > right;
    case "<=":
      return left <= right + tolerance;
    case ">=":
      return left >= right - tolerance;
    case "=":
      return Math.abs(left - right) <= tolerance;
    case "!=":
      return Math.abs(left - right) > tolerance;
    default:
      return false;
  }
}

function evaluateNode(node, scope) {
  switch (node.type) {
    case "number":
      return node.value;
    case "boolean":
      return node.value;
    case "variable":
      return scope[node.name];
    case "unary":
      return -evaluateNode(node.value, scope);
    case "binary": {
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "^":
          return Math.pow(left, right);
        default:
          throw new Error("Unknown operator.");
      }
    }
    case "compare": {
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      return compareValues(left, right, node.op);
    }
    case "logical": {
      if (node.op === "not") return !truthy(evaluateNode(node.value, scope));
      if (node.op === "and") {
        return (
          truthy(evaluateNode(node.left, scope)) &&
          truthy(evaluateNode(node.right, scope))
        );
      }
      if (node.op === "or") {
        return (
          truthy(evaluateNode(node.left, scope)) ||
          truthy(evaluateNode(node.right, scope))
        );
      }
      throw new Error("Unknown logical operator.");
    }
    case "call": {
      const fn =
        node.name in MULTI_FUNCTIONS
          ? MULTI_FUNCTIONS[node.name]
          : FUNCTIONS[node.name];
      if (!fn) throw new Error(`Unknown function "${node.name}".`);
      return fn(...node.args.map((argument) => evaluateNode(argument, scope)));
    }
    case "piecewise": {
      for (const branch of node.branches) {
        if (truthy(evaluateNode(branch.condition, scope))) {
          return evaluateNode(branch.value, scope);
        }
      }
      return node.fallback
        ? evaluateNode(node.fallback, scope)
        : Number.NaN;
    }
    case "restriction":
      return truthy(evaluateNode(node.condition, scope)) ? 1 : Number.NaN;
    default:
      throw new Error("Unknown expression node.");
  }
}

export function compileExpression(value, options = {}) {
  const source = normalizeExpression(value);
  if (!source) {
    throw new Error("Expression is empty.");
  }
  let parser;
  try {
    parser = new Parser(source, options);
    const ast = parser.parse();
    return {
      source,
      ast,
      evaluate: (x = 0, y = 0) => evaluateNode(ast, { x, y }),
    };
  } catch (error) {
    throw new Error(cleanErrorMessage(error.message, source));
  }
}

function cleanErrorMessage(message, source) {
  return message.replace(/\s+/g, " ").trim() || `Could not parse "${source}".`;
}

export function compileConstant(value) {
  const expression = compileExpression(value, { allowVariable: false });
  const result = expression.evaluate(0, 0);
  if (!Number.isFinite(result)) {
    throw new Error("Value must be a finite number.");
  }
  return { source: expression.source, value: result };
}

export function usesVariable(node, name) {
  if (!node) return false;
  if (node.type === "variable") return node.name === name;
  if (node.type === "unary") return usesVariable(node.value, name);
  if (node.type === "logical" && node.op === "not") {
    return usesVariable(node.value, name);
  }
  if (node.type === "piecewise") {
    return node.branches.some(
      (branch) =>
        usesVariable(branch.condition, name) || usesVariable(branch.value, name),
    ) || usesVariable(node.fallback, name);
  }
  if (node.type === "restriction") return usesVariable(node.condition, name);
  if (node.type === "compare" || node.type === "binary") {
    return usesVariable(node.left, name) || usesVariable(node.right, name);
  }
  if (node.type === "call") {
    return node.args.some((argument) => usesVariable(argument, name));
  }
  return false;
}

/**
 * Returns true when the expression is a polynomial in x. Used only to decide
 * whether a numerically computed volume can be presented as an exact π
 * fraction. It is a display nicety, not part of evaluation.
 */
export function isPolynomialIn(node, variable = "x") {
  if (!node) return false;
  switch (node.type) {
    case "number":
      return Number.isFinite(node.value);
    case "boolean":
      return false;
    case "variable":
      return node.name === variable;
    case "unary":
      return isPolynomialIn(node.value, variable);
    case "binary": {
      if (!isPolynomialIn(node.left, variable) || !isPolynomialIn(node.right, variable)) {
        return false;
      }
      if (node.op === "^") {
        return isConstantPolynomialExponent(node.right, variable);
      }
      return ["+", "-", "*", "/"].includes(node.op);
    }
    case "compare":
    case "logical":
    case "piecewise":
    case "restriction":
    case "call":
      return false;
    default:
      return false;
  }
}

function isConstantPolynomialExponent(node, variable) {
  if (usesVariable(node, variable)) return false;
  const value = evaluateNode(node, { x: 0, y: 0 });
  return Number.isInteger(value) && value >= 0 && value <= 24;
}

export function isExactPolynomialLine(compiled) {
  return isPolynomialIn(compiled.ast);
}

export function containsRestriction(node) {
  if (!node) return false;
  if (node.type === "restriction" || node.type === "piecewise") return true;
  if (node.type === "unary") return containsRestriction(node.value);
  if (node.type === "compare" || node.type === "binary" || node.type === "logical") {
    return containsRestriction(node.left) || containsRestriction(node.right);
  }
  if (node.type === "call") return node.args.some(containsRestriction);
  return false;
}

function simpson(f, a, b, fa, fm, fb) {
  return ((b - a) / 6) * (fa + 4 * fm + fb);
}

function adaptiveSimpson(f, a, b, fa, fm, fb, whole, eps, depth) {
  const midpoint = (a + b) / 2;
  const leftMid = (a + midpoint) / 2;
  const rightMid = (midpoint + b) / 2;
  const fLeftMid = f(leftMid);
  const fRightMid = f(rightMid);
  const left = simpson(f, a, midpoint, fa, fLeftMid, fm);
  const right = simpson(f, midpoint, b, fm, fRightMid, fb);
  const delta = left + right - whole;

  if (depth <= 0 || Math.abs(delta) <= 15 * eps) {
    return left + right + delta / 15;
  }

  return (
    adaptiveSimpson(f, a, midpoint, fa, fLeftMid, fm, left, eps / 2, depth - 1) +
    adaptiveSimpson(f, midpoint, b, fm, fRightMid, fb, right, eps / 2, depth - 1)
  );
}

export function integrate(f, a, b, options = {}) {
  const { eps = 1e-8, maxDepth = 20 } = options;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return 0;
  const direction = a < b ? 1 : -1;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  const fa = f(start);
  const fb = f(end);
  const fm = f((start + end) / 2);
  if (![fa, fb, fm].every(Number.isFinite)) {
    throw new Error("The integral is not finite over this interval.");
  }
  const whole = simpson(f, start, end, fa, fm, fb);
  const result = adaptiveSimpson(
    f,
    start,
    end,
    fa,
    fm,
    fb,
    whole,
    Math.max(eps, 1e-10),
    maxDepth,
  );
  return direction * result;
}

export function formatNumber(value, maxDecimals = 4) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 1e-11) return "0";
  const rounded = Number(value.toFixed(maxDecimals));
  return String(rounded);
}

export function evaluateExpression(compiled, x) {
  const value = compiled.evaluate(x, 0);
  if (!Number.isFinite(value)) {
    throw new Error("The expression produced a non-finite value.");
  }
  return value;
}

export function sampleSign(value, tolerance = 1e-9) {
  if (value > tolerance) return 1;
  if (value < -tolerance) return -1;
  return 0;
}

/**
 * Continued-fraction approximation. This turns 107.233... / π into 512 / 15
 * so polynomial volumes can be displayed as exact fractions.
 */
export function approximateFraction(value, options = {}) {
  const { maxDenominator = 100000, tolerance = 1e-9 } = options;
  if (!Number.isFinite(value)) return null;
  const sign = value < 0 ? -1 : 1;
  const target = Math.abs(value);
  if (target < 1e-12) return { numerator: 0, denominator: 1 };

  let previousNumerator = 0;
  let numerator = 1;
  let previousDenominator = 1;
  let denominator = 0;
  let remainder = target;

  for (let iteration = 0; iteration < 40; iteration++) {
    const whole = Math.floor(remainder);
    const nextNumerator = whole * numerator + previousNumerator;
    const nextDenominator = whole * denominator + previousDenominator;

    if (
      nextDenominator > 0 &&
      nextDenominator <= maxDenominator &&
      Math.abs(target - nextNumerator / nextDenominator) <=
        tolerance * Math.max(1, target)
    ) {
      return {
        numerator: sign * nextNumerator,
        denominator: nextDenominator,
      };
    }

    previousNumerator = numerator;
    numerator = nextNumerator;
    previousDenominator = denominator;
    denominator = nextDenominator;

    const fractional = remainder - whole;
    if (fractional < 1e-14) break;
    remainder = 1 / fractional;
  }

  return null;
}

export function fractionToLabel(fraction) {
  if (!fraction) return null;
  if (fraction.denominator === 1) return String(fraction.numerator);
  return `${fraction.numerator}/${fraction.denominator}`;
}

export function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}
