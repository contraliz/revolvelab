const CONSTANTS = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

const FUNCTIONS = {
  abs: Math.abs,
  acos: Math.acos,
  acosh: Math.acosh,
  asin: Math.asin,
  asinh: Math.asinh,
  atan: Math.atan,
  atanh: Math.atanh,
  cbrt: Math.cbrt,
  ceil: Math.ceil,
  cos: Math.cos,
  cosh: Math.cosh,
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  round: Math.round,
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
  pow: (a, b) => Math.pow(a, b),
};

export function normalizeExpression(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";

  text = text
    .replace(/^\s*(?:f|g|h|y)\s*(?:\(\s*x\s*\))?\s*=\s*/i, "")
    .replace(/^[a-z]\s*\(\s*x\s*\)\s*=\s*/i, "")
    .replace(/[−–—]/g, "-")
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/π/g, "pi")
    .replace(/∞/g, "Infinity")
    .replace(/√\s*\(/g, "sqrt(")
    .replace(/√\s*([a-zA-Z0-9.]+)/g, "sqrt($1)")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/⁴/g, "^4")
    .replace(/\bMath\./g, "")
    .replace(/\*\*/g, "^")
    .trim();

  return text;
}

class Tokenizer {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.tokens = [];
    this.tokenize();
    this.position = 0;
  }

  tokenize() {
    const source = this.source;
    let i = 0;
    while (i < source.length) {
      const char = source[i];
      if (/\s/.test(char)) {
        i += 1;
        continue;
      }

      if (/[0-9.]/.test(char)) {
        const match = source
          .slice(i)
          .match(/^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
        if (!match) {
          throw new Error(`Invalid number near "${source.slice(i, i + 8)}".`);
        }
        this.tokens.push({ type: "number", value: Number(match[0]), index: i });
        i += match[0].length;
        continue;
      }

      if (/[a-zA-Z]/.test(char)) {
        const match = source.slice(i).match(/^[a-zA-Z][a-zA-Z0-9_]*/);
        const name = match[0];
        this.tokens.push({ type: "identifier", value: name, index: i });
        i += name.length;
        continue;
      }

      if ("+-*/^(),".includes(char)) {
        this.tokens.push({ type: char, value: char, index: i });
        i += 1;
        continue;
      }

      throw new Error(`Unexpected character "${char}".`);
    }

    this.tokens.push({ type: "eof", value: "", index: i });
  }

  peek() {
    return this.tokens[this.position];
  }

  consume(type) {
    const token = this.peek();
    if (token.type !== type) return null;
    this.position += 1;
    return token;
  }

  expect(type, label) {
    const token = this.consume(type);
    if (!token) {
      const found = this.peek();
      throw new Error(
        `Expected ${label || type} near "${this.source.slice(
          Math.max(0, found.index - 1),
          found.index + 8,
        )}".`,
      );
    }
    return token;
  }
}

class Parser {
  constructor(source, options = {}) {
    this.source = source;
    this.allowVariable = options.allowVariable !== false;
    this.tokens = new Tokenizer(source);
  }

  parse() {
    const ast = this.parseExpression();
    if (this.tokens.peek().type !== "eof") {
      const token = this.tokens.peek();
      throw new Error(`Unexpected "${token.value}" at position ${token.index + 1}.`);
    }
    return ast;
  }

  parseExpression() {
    let left = this.parseTerm();
    while (true) {
      if (this.tokens.consume("+")) {
        left = { type: "binary", op: "+", left, right: this.parseTerm() };
      } else if (this.tokens.consume("-")) {
        left = { type: "binary", op: "-", left, right: this.parseTerm() };
      } else {
        break;
      }
    }
    return left;
  }

  parseTerm() {
    let left = this.parseUnary();
    while (true) {
      if (this.tokens.consume("*")) {
        left = { type: "binary", op: "*", left, right: this.parseUnary() };
      } else if (this.tokens.consume("/")) {
        left = { type: "binary", op: "/", left, right: this.parseUnary() };
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
    const type = this.tokens.peek().type;
    return type === "number" || type === "identifier" || type === "(";
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
      const name = rawName.toLowerCase();

      if (this.tokens.peek().type === "(") {
        if (name in FUNCTIONS || name in MULTI_FUNCTIONS) {
          this.tokens.position += 1;
          const args = [];
          if (this.tokens.peek().type !== ")") {
            args.push(this.parseExpression());
            while (this.tokens.consume(",")) {
              args.push(this.parseExpression());
            }
          }
          this.tokens.expect(")", "closing )");
          if (name in MULTI_FUNCTIONS) {
            if (args.length < 2) {
              throw new Error(`Function "${name}" needs at least two arguments.`);
            }
          } else if (args.length !== 1) {
            throw new Error(`Function "${name}" needs exactly one argument.`);
          }
          return { type: "call", name, args };
        }

        if (
          !(name in CONSTANTS) &&
          name !== "x" &&
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

      if (name === "infinity") {
        return { type: "number", value: Infinity };
      }

      throw new Error(`Unknown symbol "${rawName}". Use x as the variable.`);
    }

    if (this.tokens.consume("(")) {
      const value = this.parseExpression();
      this.tokens.expect(")", "closing )");
      return value;
    }

    throw new Error(
      `Unexpected token "${token.value || "end of input"}" near position ${
        token.index + 1
      }.`,
    );
  }
}

function evaluateNode(node, scope) {
  switch (node.type) {
    case "number":
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
    case "call": {
      const fn =
        node.name in MULTI_FUNCTIONS
          ? MULTI_FUNCTIONS[node.name]
          : FUNCTIONS[node.name];
      return fn(...node.args.map((arg) => evaluateNode(arg, scope)));
    }
    default:
      throw new Error("Unknown expression node.");
  }
}

export function compileExpression(value, options = {}) {
  const source = normalizeExpression(value);
  if (!source) {
    throw new Error("Expression is empty.");
  }
  const parser = new Parser(source, options);
  const ast = parser.parse();
  return {
    source,
    evaluate: (x = 0) => evaluateNode(ast, { x }),
  };
}

export function compileConstant(value) {
  const expression = compileExpression(value, { allowVariable: false });
  const result = expression.evaluate(0);
  if (!Number.isFinite(result)) {
    throw new Error("Value must be a finite number.");
  }
  return { source: expression.source, value: result };
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
  const value = compiled.evaluate(x);
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
