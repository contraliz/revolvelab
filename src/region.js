import {
  approximateFraction,
  compileAst,
  compileConstant,
  compileExpression,
  containsRestriction,
  formatExactNumber,
  formatNumber,
  integrate,
  isPolynomialIn,
  normalizeExpression,
  stripFunctionPrefix,
  usesVariable,
} from "./expression.js";

const SEARCH_SAMPLES = 1800;
const ROOT_SAMPLES = 2400;
const POLYGON_SAMPLES = 640;

export class RegionError extends Error {
  constructor(message, lineId = null) {
    super(message);
    this.name = "RegionError";
    this.lineId = lineId;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function near(a, b, tolerance = 1e-7) {
  return Math.abs(a - b) <= tolerance;
}

function safeEvaluate(line, x) {
  try {
    const value = line.evaluate(x);
    return Number.isFinite(value) ? value : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * Split trailing restriction braces from a line. This is what lets a
 * restriction such as {0 <= y <= 2} be evaluated against the value of the
 * function, not against an arbitrary y.
 */
function splitTrailingRestrictions(text) {
  let body = text.trim();
  const groups = [];

  while (body.endsWith("}")) {
    let depth = 0;
    let start = -1;
    for (let index = body.length - 1; index >= 0; index--) {
      const character = body[index];
      if (character === "}") depth += 1;
      if (character === "{") {
        depth -= 1;
        if (depth === 0) {
          start = index;
          break;
        }
      }
    }
    if (start < 0) break;
    const group = body.slice(start + 1, -1).trim();
    if (!group) break;

    // A group with a top-level colon is a piecewise expression, not a
    // restriction. Leave it attached to the function body.
    let colonDepth = 0;
    let hasColon = false;
    for (const character of group) {
      if (character === "(" || character === "{" || character === "[") colonDepth += 1;
      if (character === ")" || character === "}" || character === "]") colonDepth -= 1;
      if (character === ":" && colonDepth === 0) {
        hasColon = true;
        break;
      }
    }
    if (hasColon) break;

    groups.unshift(group);
    body = body.slice(0, start).trim();
  }

  if (!body) return { core: text.trim(), restrictions: [] };
  return { core: body, restrictions: groups };
}

function isSquarePolynomial(node) {
  if (!node) return false;
  if (isPolynomialIn(node)) return true;
  if (node.type === "unary") return isSquarePolynomial(node.value);
  if (node.type === "call") {
    if ((node.name === "sqrt" || node.name === "abs") && node.args.length === 1) {
      return isPolynomialIn(node.args[0]);
    }
    return false;
  }
  if (node.type === "binary") {
    if (node.op === "*") {
      return isSquarePolynomial(node.left) && isSquarePolynomial(node.right);
    }
    if (node.op === "/") {
      return isSquarePolynomial(node.left) && isPolynomialIn(node.right);
    }
    if (node.op === "^") {
      // x^(1/2) is another spelling of sqrt(x), and x^(n/2) squares to a
      // polynomial, so the volume integral remains exact.
      const exponent = constantNumericValue(node.right);
      const doubled = exponent === null ? null : exponent * 2;
      if (
        Number.isInteger(doubled) &&
        doubled >= 1 &&
        isPolynomialIn(node.left)
      ) {
        return true;
      }
    }
  }
  return false;
}

function containsConstantSymbol(source) {
  return /\b(?:pi|tau|e)\b/i.test(source) || /[πτ]/.test(source);
}

function isExplicitFunctionLeft(text) {
  return /^\s*(?:y|f\s*\(\s*x\s*\)|[a-z]\s*\(\s*x\s*\))\s*$/i.test(text);
}

function makeFunctionLine({
  input,
  index,
  coreExpression,
  source,
  restrictions,
  implicit = false,
}) {
  const evaluate = (x) => {
    const value = coreExpression.evaluate(x, 0);
    if (!Number.isFinite(value)) return Number.NaN;
    for (const restriction of restrictions) {
      const allowed = restriction.evaluate(x, value);
      if (!allowed || Number.isNaN(allowed)) return Number.NaN;
    }
    return value;
  };

  return {
    id: input.id,
    index,
    raw: String(input.text ?? "").trim(),
    color: input.color,
    kind: "function",
    implicit,
    hidden: Boolean(input.hidden),
    role: input.role ?? null,
    parentId: input.parentId ?? null,
    branchIndex: 0,
    source,
    core: coreExpression,
    restrictions,
    evaluate,
    polynomial:
      isPolynomialIn(coreExpression.ast) &&
      !containsConstantSymbol(source),
    squarePolynomial:
      isSquarePolynomial(coreExpression.ast) &&
      !containsConstantSymbol(source),
    hasRestriction:
      restrictions.length > 0 || containsRestriction(coreExpression.ast),
    domainRuns: [],
  };
}

function makeVerticalLine({ input, index, value }) {
  return {
    id: input.id,
    index,
    raw: String(input.text ?? "").trim(),
    color: input.color,
    kind: "vertical",
    implicit: Boolean(input.implicit),
    hidden: Boolean(input.hidden),
    role: input.role ?? null,
    parentId: input.parentId ?? null,
    branchIndex: 0,
    verticalX: value,
    source: `x = ${
      formatExactNumber(value) ??
      formatNumber(value, 6).replace("-", "−")
    }`,
    core: null,
    restrictions: [],
    evaluate: () => Number.NaN,
    polynomial: false,
    squarePolynomial: false,
    hasRestriction: false,
    domainRuns: [],
  };
}

function makeImplicitLine({
  input,
  index,
  branchIndex,
  ast,
  restrictions,
}) {
  const source = displayExpression(ast, 0, "x") || "0";
  const coreExpression = compileAst(ast, { source });
  const evaluate = (x) => {
    const value = coreExpression.evaluate(x, 0);
    if (!Number.isFinite(value)) return Number.NaN;
    for (const restriction of restrictions) {
      const allowed = restriction.evaluate(x, value);
      if (!allowed || Number.isNaN(allowed)) return Number.NaN;
    }
    return value;
  };

  return {
    id: `${input.id}::branch-${branchIndex}`,
    index,
    raw: String(input.text ?? "").trim(),
    color: input.color,
    kind: "function",
    implicit: true,
    hidden: Boolean(input.hidden),
    role: input.role ?? null,
    parentId: input.id,
    branchIndex,
    source,
    core: coreExpression,
    restrictions,
    evaluate,
    polynomial:
      isPolynomialIn(ast, "x") &&
      !containsConstantSymbol(source),
    squarePolynomial:
      isSquarePolynomial(ast) &&
      !containsConstantSymbol(source),
    hasRestriction:
      restrictions.length > 0 || containsRestriction(ast),
    domainRuns: [],
  };
}

function trimPolynomial(coefficients) {
  const result = [...coefficients];
  while (result.length > 1 && symbolicValue(result.at(-1)) === 0) {
    result.pop();
  }
  return result;
}

function multiplyPolynomials(left, right) {
  const degree = left.length + right.length - 2;
  if (degree > 2) return null;
  const result = Array.from({ length: degree + 1 }, () => symbolicNumber(0));
  for (let first = 0; first < left.length; first++) {
    for (let second = 0; second < right.length; second++) {
      result[first + second] = symbolicBinary(
        "+",
        result[first + second],
        symbolicBinary("*", left[first], right[second]),
      );
    }
  }
  return trimPolynomial(result);
}

function constantNumericValue(node) {
  if (!node || usesVariable(node, "x") || usesVariable(node, "y")) return null;
  const value = evaluateSymbolic(node, 0);
  return Number.isFinite(value) ? value : null;
}

/**
 * Collect c0 + c1*y + c2*y^2 for a conic (or any expression that stays at most
 * quadratic in y). Coefficients are ASTs in x. Returning null means the
 * expression is outside the supported class and the caller can explain that.
 */
function polynomialCoefficients(node, variable, depth = 0) {
  if (!node || depth > 12) return null;

  if (node.type === "number") return [symbolicNumber(node.value)];
  if (node.type === "variable") {
    return node.name === variable
      ? [symbolicNumber(0), symbolicNumber(1)]
      : [node];
  }
  if (node.type === "unary") {
    const inner = polynomialCoefficients(node.value, variable, depth + 1);
    return inner
      ? inner.map((coefficient) => symbolicUnary(coefficient))
      : null;
  }
  if (node.type === "call") {
    return usesVariable(node, variable) ? null : [node];
  }
  if (node.type !== "binary") return null;

  const left = polynomialCoefficients(node.left, variable, depth + 1);
  const right = polynomialCoefficients(node.right, variable, depth + 1);
  if (!left || !right) return null;

  if (node.op === "+" || node.op === "-") {
    const length = Math.max(left.length, right.length);
    return trimPolynomial(
      Array.from({ length }, (_, index) =>
        symbolicBinary(
          node.op,
          left[index] ?? symbolicNumber(0),
          right[index] ?? symbolicNumber(0),
        ),
      ),
    );
  }

  if (node.op === "*") return multiplyPolynomials(left, right);

  if (node.op === "/") {
    if (usesVariable(node.right, variable)) return null;
    return trimPolynomial(
      left.map((coefficient) =>
        symbolicBinary("/", coefficient, node.right),
      ),
    );
  }

  if (node.op === "^") {
    if (usesVariable(node.right, variable)) return null;
    const exponent = constantNumericValue(node.right);
    if (!Number.isInteger(exponent) || exponent < 0 || exponent > 2) {
      return null;
    }
    let result = [symbolicNumber(1)];
    for (let index = 0; index < exponent; index++) {
      result = multiplyPolynomials(result, left);
      if (!result) return null;
    }
    return result;
  }

  return null;
}

function solvePolynomialForVariable(coefficients) {
  const trimmed = trimPolynomial(coefficients);
  const degree = trimmed.length - 1;
  if (degree <= 0) return [];
  if (degree === 1) {
    const [constant, linear] = trimmed;
    return [symbolicBinary("/", symbolicUnary(constant), linear)];
  }
  if (degree === 2) {
    const [constant, linear, quadratic] = trimmed;
    const discriminant = symbolicBinary(
      "-",
      symbolicBinary("^", linear, symbolicNumber(2)),
      symbolicBinary(
        "*",
        symbolicNumber(4),
        symbolicBinary("*", quadratic, constant),
      ),
    );
    const root = symbolicCall("sqrt", [discriminant]);
    const denominator = symbolicBinary(
      "*",
      symbolicNumber(2),
      quadratic,
    );
    const negativeLinear = symbolicUnary(linear);
    return [
      symbolicBinary(
        "/",
        symbolicBinary("+", negativeLinear, root),
        denominator,
      ),
      symbolicBinary(
        "/",
        symbolicBinary("-", negativeLinear, root),
        denominator,
      ),
    ];
  }
  return [];
}

function solveImplicitBranches(leftAst, rightAst) {
  const leftHasY = usesVariable(leftAst, "y");
  const rightHasY = usesVariable(rightAst, "y");
  if (!leftHasY && !rightHasY) return [];

  let branches = [];
  if (leftHasY !== rightHasY) {
    branches = leftHasY
      ? invertExpression(leftAst, rightAst, 0, "y")
      : invertExpression(rightAst, leftAst, 0, "y");
  }

  if (branches.length === 0) {
    const coefficients = polynomialCoefficients(
      symbolicBinary("-", leftAst, rightAst),
      "y",
    );
    if (coefficients) branches = solvePolynomialForVariable(coefficients);
  }

  const seen = new Set();
  return branches.filter((branch) => {
    if (!branch || usesVariable(branch, "y")) return false;
    const source = displayExpression(branch, 0, "x");
    if (!source || seen.has(source)) return false;
    seen.add(source);
    return true;
  });
}

function compileImplicitLine(
  input,
  index,
  leftText,
  rightText,
  restrictions,
) {
  let left;
  let right;
  try {
    left = compileExpression(leftText);
    right = compileExpression(rightText);
  } catch (error) {
    throw new RegionError(`Implicit equation: ${error.message}`, input.id);
  }

  if (!usesVariable(left.ast, "y") && !usesVariable(right.ast, "y")) {
    throw new RegionError(
      "This equation does not contain y. Enter a function of x or a vertical line x = c.",
      input.id,
    );
  }

  const branches = solveImplicitBranches(left.ast, right.ast);
  if (branches.length === 0) {
    throw new RegionError(
      "Could not solve this implicit equation for y. Rewrite it as y = f(x), or use a conic such as x^2 + y^2 = 1.",
      input.id,
    );
  }

  return branches.map((ast, branchIndex) =>
    makeImplicitLine({
      input,
      index,
      branchIndex,
      ast,
      restrictions,
    }),
  );
}

function compileLine(input, index) {
  const raw = String(input.text ?? "").trim();
  if (!raw) return [];

  const normalized = normalizeExpression(raw);
  const { core: body, restrictions } = splitTrailingRestrictions(normalized);
  if (!body) {
    throw new RegionError("This line does not contain a function.", input.id);
  }

  const restrictionExpressions = [];
  for (const text of restrictions) {
    try {
      restrictionExpressions.push(compileExpression(text));
    } catch (error) {
      throw new RegionError(`Restriction: ${error.message}`, input.id);
    }
  }

  const verticalMatch = body.match(/^\s*x\s*=\s*(.+)$/i);
  if (verticalMatch) {
    let constant = null;
    try {
      constant = compileConstant(verticalMatch[1]);
    } catch {
      constant = null;
    }
    if (constant) {
      if (!Number.isFinite(constant.value)) {
        throw new RegionError(
          "A vertical line needs a finite x-value.",
          input.id,
        );
      }
      return [makeVerticalLine({ input, index, value: constant.value })];
    }
  }

  // Leave piecewise expressions alone: a colon or comparison inside braces is
  // not an equation separator for the line.
  if (!body.trim().startsWith("{")) {
    let separator;
    try {
      separator = findEquationSeparator(body);
    } catch (error) {
      throw new RegionError(error.message, input.id);
    }

    if (separator >= 0) {
      const leftText = body.slice(0, separator).trim();
      const rightText = body.slice(separator + 1).trim();
      if (!leftText || !rightText) {
        throw new RegionError(
          "An equation needs an expression on both sides of =.",
          input.id,
        );
      }

      if (isExplicitFunctionLeft(leftText)) {
        let right;
        try {
          right = compileExpression(rightText);
        } catch (error) {
          throw new RegionError(error.message, input.id);
        }
        if (!usesVariable(right.ast, "y")) {
          return [
            makeFunctionLine({
              input,
              index,
              coreExpression: right,
              source: rightText,
              restrictions: restrictionExpressions,
              implicit: Boolean(input.implicit),
            }),
          ];
        }
      }

      return compileImplicitLine(
        input,
        index,
        leftText,
        rightText,
        restrictionExpressions,
      );
    }
  }

  const stripped = stripFunctionPrefix(body);
  if (!stripped) {
    throw new RegionError("Enter a function or a vertical line x = c.", input.id);
  }

  let coreExpression;
  try {
    coreExpression = compileExpression(stripped);
  } catch (error) {
    throw new RegionError(error.message, input.id);
  }

  if (
    coreExpression.ast.type === "compare" ||
    coreExpression.ast.type === "logical"
  ) {
    throw new RegionError(
      "This is a condition, not a function. Enter y = f(x), then add a restriction like {0 <= x <= 2}.",
      input.id,
    );
  }

  if (usesVariable(coreExpression.ast, "y")) {
    return compileImplicitLine(
      input,
      index,
      stripped,
      "0",
      restrictionExpressions,
    );
  }

  return [
    makeFunctionLine({
      input,
      index,
      coreExpression,
      source: stripped,
      restrictions: restrictionExpressions,
      implicit: Boolean(input.implicit),
    }),
  ];
}

/**
 * True when a line is an equation in both x and y (or a bare expression that
 * contains y) and therefore needs implicit handling. Vertical lines and
 * ordinary y = f(x) inputs stay on the explicit path.
 */
export function isImplicitEquationInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;

  const { core } = splitTrailingRestrictions(normalizeExpression(raw));
  if (!core) return false;

  if (core.trim().startsWith("{")) {
    try {
      return usesVariable(compileExpression(core).ast, "y");
    } catch {
      return false;
    }
  }

  const verticalMatch = core.match(/^\s*x\s*=\s*(.+)$/i);
  if (verticalMatch) {
    try {
      compileConstant(verticalMatch[1]);
      return false;
    } catch {
      // Not a constant vertical boundary; it may still be an implicit curve.
    }
  }

  let separator;
  try {
    separator = findEquationSeparator(core);
  } catch {
    return false;
  }

  if (separator >= 0) {
    const leftText = core.slice(0, separator).trim();
    const rightText = core.slice(separator + 1).trim();
    if (!leftText || !rightText) return false;
    if (isExplicitFunctionLeft(leftText)) {
      try {
        return usesVariable(compileExpression(rightText).ast, "y");
      } catch {
        return true;
      }
    }
    return true;
  }

  const stripped = stripFunctionPrefix(core);
  if (!stripped) return false;
  try {
    return usesVariable(compileExpression(stripped).ast, "y");
  } catch {
    return false;
  }
}

function numericLiterals(text) {
  const matches = String(text).match(/(?:\d+(?:\.\d*)?|\.\d+)/g) || [];
  return matches
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function searchWindowFor(inputs, lines) {
  let largest = 6;
  for (const input of inputs) {
    for (const value of numericLiterals(input.text)) {
      largest = Math.max(largest, Math.abs(value));
    }
  }
  for (const line of lines) {
    for (const value of numericLiterals(line.source)) {
      largest = Math.max(largest, Math.abs(value));
    }
  }
  const limit = clamp(largest * 1.5 + 3, 10, 80);
  return { min: -limit, max: limit, span: limit * 2 };
}

function scanDomain(line, window) {
  const runs = [];
  const samples = SEARCH_SAMPLES;
  const step = window.span / samples;
  let runStart = null;

  const refineBoundary = (inside, outside) => {
    let left = outside;
    let right = inside;
    for (let iteration = 0; iteration < 55; iteration++) {
      const middle = (left + right) / 2;
      if (Number.isFinite(safeEvaluate(line, middle))) {
        right = middle;
      } else {
        left = middle;
      }
    }
    return (left + right) / 2;
  };

  for (let index = 0; index <= samples; index++) {
    const x = window.min + index * step;
    const finite = Number.isFinite(safeEvaluate(line, x));

    if (finite && runStart === null) {
      runStart = index === 0 ? window.min : x;
      if (index > 0) {
        runStart = refineBoundary(x, x - step);
      }
    } else if (!finite && runStart !== null) {
      const previousX = window.min + (index - 1) * step;
      const end = refineBoundary(previousX, x);
      runs.push({
        a: runStart,
        b: end,
        closedLeft: runStart > window.min + step * 0.25,
        closedRight: end < window.max - step * 0.25,
      });
      runStart = null;
    }
  }

  if (runStart !== null) {
    runs.push({
      a: runStart,
      b: window.max,
      closedLeft: runStart > window.min + step * 0.25,
      closedRight: false,
    });
  }

  // Merge runs that meet at removable discontinuities.
  const merged = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (
      previous &&
      run.a - previous.b < step * 0.35 &&
      previous.b > previous.a
    ) {
      previous.b = run.b;
      previous.closedRight = run.closedRight;
    } else {
      merged.push({ ...run });
    }
  }

  line.domainRuns = merged;
  return merged;
}

function withinDomain(line, x) {
  return Number.isFinite(safeEvaluate(line, x));
}

function bisectRoot(lowerLine, upperLine, left, right) {
  let a = left;
  let b = right;
  let fa = safeEvaluate(lowerLine, a) - safeEvaluate(upperLine, a);
  for (let iteration = 0; iteration < 70; iteration++) {
    const middle = (a + b) / 2;
    const value = safeEvaluate(lowerLine, middle) - safeEvaluate(upperLine, middle);
    if (!Number.isFinite(value)) break;
    if (Math.abs(value) < 1e-12) return middle;
    if (Math.sign(value) === Math.sign(fa)) {
      a = middle;
      fa = value;
    } else {
      b = middle;
    }
  }
  return (a + b) / 2;
}

function goldenMinimum(fn, left, right) {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = left;
  let b = right;
  let c = b - ratio * (b - a);
  let d = a + ratio * (b - a);
  let fc = fn(c);
  let fd = fn(d);
  for (let iteration = 0; iteration < 45; iteration++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - ratio * (b - a);
      fc = fn(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + ratio * (b - a);
      fd = fn(d);
    }
  }
  return (a + b) / 2;
}

function findIntersections(first, second, window) {
  const roots = [];
  const samples = ROOT_SAMPLES;
  const step = window.span / samples;
  const xs = new Array(samples + 1);
  const values = new Array(samples + 1);

  for (let index = 0; index <= samples; index++) {
    const x = window.min + index * step;
    xs[index] = x;
    const a = safeEvaluate(first, x);
    const b = safeEvaluate(second, x);
    values[index] = Number.isFinite(a) && Number.isFinite(b) ? a - b : Number.NaN;
  }

  const pushRoot = (x) => {
    if (!Number.isFinite(x)) return;
    if (roots.every((existing) => Math.abs(existing - x) > step * 0.08)) {
      roots.push(x);
    }
  };

  for (let index = 1; index <= samples; index++) {
    const previous = values[index - 1];
    const current = values[index];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    if (Math.abs(previous) < 1e-12) pushRoot(xs[index - 1]);
    if (Math.abs(current) < 1e-12) pushRoot(xs[index]);
    if (Math.sign(previous) !== Math.sign(current)) {
      pushRoot(bisectRoot(first, second, xs[index - 1], xs[index]));
    }
  }

  // Tangencies do not change sign. Detect local minima of |f - g| and
  // refine them before deciding whether they are real intersections.
  for (let index = 1; index < samples; index++) {
    const before = values[index - 1];
    const current = values[index];
    const after = values[index + 1];
    if (![before, current, after].every(Number.isFinite)) continue;
    if (
      Math.abs(current) <= Math.abs(before) &&
      Math.abs(current) <= Math.abs(after)
    ) {
      const differenceAt = (x) =>
        Math.abs(safeEvaluate(first, x) - safeEvaluate(second, x));
      const x = goldenMinimum(
        differenceAt,
        xs[index - 1],
        xs[index + 1],
      );
      const value = differenceAt(x);
      const scale = Math.max(1, Math.abs(safeEvaluate(first, x)));
      if (Number.isFinite(value) && value < 1e-8 * scale) pushRoot(x);
    }
  }

  return roots;
}

function dedupeEvents(events, tolerance) {
  const sorted = [...events].sort((a, b) => a - b);
  const unique = [];
  for (const event of sorted) {
    const previous = unique.at(-1);
    if (previous === undefined || Math.abs(previous - event) > tolerance) {
      unique.push(event);
    } else {
      unique[unique.length - 1] = (previous + event) / 2;
    }
  }
  return unique;
}

function activeLinesAt(lines, x) {
  return lines
    .map((line) => ({ line, value: safeEvaluate(line, x) }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((a, b) => a.value - b.value);
}

function mergeSegments(segments, tolerance) {
  const merged = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.lowerId === segment.lowerId &&
      previous.upperId === segment.upperId &&
      near(previous.b, segment.a, tolerance)
    ) {
      previous.b = segment.b;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function cellArea(cell) {
  const samples = 32;
  let total = 0;
  for (let index = 0; index < samples; index++) {
    const x =
      cell.a + ((cell.b - cell.a) * (index + 0.5)) / samples;
    const lower = safeEvaluate(cell.lowerLine, x);
    const upper = safeEvaluate(cell.upperLine, x);
    if (Number.isFinite(lower) && Number.isFinite(upper)) {
      total += Math.max(0, upper - lower) * ((cell.b - cell.a) / samples);
    }
  }
  return total;
}

function pairEndpointClosed(cell, endpoint, side, verticalXs = []) {
  const exactLower = safeEvaluate(cell.lowerLine, endpoint);
  const exactUpper = safeEvaluate(cell.upperLine, endpoint);
  if (Number.isFinite(exactLower) && Number.isFinite(exactUpper)) {
    const tolerance =
      1e-5 * Math.max(1, Math.abs(exactLower), Math.abs(exactUpper));
    if (Math.abs(exactUpper - exactLower) <= tolerance) return true;
  }

  const width = cell.b - cell.a;
  const epsilon = Math.max(1e-9, width * 1e-7);
  const x = side === "left" ? endpoint + epsilon : endpoint - epsilon;
  const nearLower = safeEvaluate(cell.lowerLine, x);
  const nearUpper = safeEvaluate(cell.upperLine, x);
  if (Number.isFinite(nearLower) && Number.isFinite(nearUpper)) {
    const tolerance =
      1e-5 * Math.max(1, Math.abs(nearLower), Math.abs(nearUpper));
    if (Math.abs(nearUpper - nearLower) <= tolerance) return true;
  }

  // A cusp such as sqrt(x) meeting x at the origin has one branch whose value
  // is only defined infinitesimally inside the endpoint. Compare the limiting
  // values from inside the cell instead of requiring both curves to be finite
  // at the endpoint itself.
  const limitEpsilon = Math.max(1e-12, width * 1e-12);
  const limitX =
    side === "left" ? endpoint + limitEpsilon : endpoint - limitEpsilon;
  const limitLower = safeEvaluate(cell.lowerLine, limitX);
  const limitUpper = safeEvaluate(cell.upperLine, limitX);
  if (Number.isFinite(limitLower) && Number.isFinite(limitUpper)) {
    const scale = Math.min(
      Math.max(1, Math.abs(limitLower), Math.abs(limitUpper)),
      100,
    );
    if (Math.abs(limitUpper - limitLower) <= 1e-4 * scale) return true;
  }

  const eventTolerance = Math.max(1e-7, cell.span * 1e-6);
  if (verticalXs.some((value) => near(endpoint, value, eventTolerance))) {
    return true;
  }
  for (const line of [cell.lowerLine, cell.upperLine]) {
    // A natural domain endpoint, such as the left edge of a circle, is a
    // cusp where the curve turns back; it is not a wall that closes a region.
    // Only an explicit restriction (or a vertical line, handled above) cuts
    // the region off at a domain boundary.
    if (!line.hasRestriction) continue;
    for (const run of line.domainRuns) {
      if (
        side === "left" &&
        run.closedLeft &&
        near(endpoint, run.a, eventTolerance) &&
        run.b > endpoint + epsilon
      ) {
        return true;
      }
      if (
        side === "right" &&
        run.closedRight &&
        near(endpoint, run.b, eventTolerance) &&
        run.a < endpoint - epsilon
      ) {
        return true;
      }
    }
  }
  return false;
}

function pairCellSegments(first, second, window, verticalXs = []) {
  const events = [];
  for (const line of [first, second]) {
    for (const run of line.domainRuns) {
      if (run.closedLeft) events.push(run.a);
      if (run.closedRight) events.push(run.b);
    }
  }
  events.push(...findIntersections(first, second, window));
  events.push(
    ...verticalXs.filter((value) => value > window.min && value < window.max),
  );

  const unique = dedupeEvents(
    events.filter((value) => value > window.min && value < window.max),
    Math.max(1e-6, window.span * 1e-7),
  );
  if (unique.length < 2) return [];

  const segments = [];
  for (let index = 0; index < unique.length - 1; index++) {
    const a = unique[index];
    const b = unique[index + 1];
    if (b - a < 1e-7) continue;
    const middle = (a + b) / 2;
    const firstValue = safeEvaluate(first, middle);
    const secondValue = safeEvaluate(second, middle);
    if (!Number.isFinite(firstValue) || !Number.isFinite(secondValue)) continue;
    if (Math.abs(firstValue - secondValue) < 1e-9) continue;
    const lowerLine = firstValue < secondValue ? first : second;
    const upperLine = firstValue < secondValue ? second : first;
    segments.push({
      a,
      b,
      lowerId: lowerLine.id,
      upperId: upperLine.id,
      lowerLine,
      upperLine,
    });
  }

  return mergeSegments(segments, Math.max(1e-6, window.span * 1e-7));
}

function buildPairCells(lines, window, verticalXs = [], options = {}) {
  const cells = [];

  for (let first = 0; first < lines.length; first++) {
    for (let second = first + 1; second < lines.length; second++) {
      const segments = pairCellSegments(
        lines[first],
        lines[second],
        window,
        verticalXs,
      );
      for (const segment of segments) {
        if (options.clipXMin !== null && options.clipXMin !== undefined) {
          segment.a = Math.max(segment.a, options.clipXMin);
        }
        if (segment.b - segment.a < 1e-7) continue;
        if (options.clipYMin !== null && options.clipYMin !== undefined) {
          const middle = (segment.a + segment.b) / 2;
          const lower = safeEvaluate(segment.lowerLine, middle);
          const upper = safeEvaluate(segment.upperLine, middle);
          const tolerance = 1e-7 * Math.max(1, Math.abs(lower), Math.abs(upper));
          if (
            !Number.isFinite(lower) ||
            !Number.isFinite(upper) ||
            lower < options.clipYMin - tolerance ||
            upper < options.clipYMin - tolerance
          ) {
            continue;
          }
        }
        const cell = {
          ...segment,
          span: segment.b - segment.a,
          lower: (x) => safeEvaluate(segment.lowerLine, x),
          upper: (x) => safeEvaluate(segment.upperLine, x),
          polygon: null,
          polygonLocal: null,
          uRange: null,
        };
        if (
          !pairEndpointClosed(cell, cell.a, "left", verticalXs) ||
          !pairEndpointClosed(cell, cell.b, "right", verticalXs)
        ) {
          continue;
        }
        const area = cellArea(cell);
        if (area < 1e-7) continue;
        cell.area = area;
        cells.push(cell);
      }
    }
  }

  // Adjacent-pair cells can nest (an internal curve cuts a larger region into
  // a lens). Keep the outer cells so the filled region is the union, not a
  // double-counted stack.
  const outerCells = cells.filter((cell, index) => {
    return !cells.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      if (other.area <= cell.area * (1 + 1e-6)) return false;
      if (other.a > cell.a + 1e-7 || other.b < cell.b - 1e-7) return false;
      const samples = 9;
      for (let sample = 0; sample < samples; sample++) {
        const x = cell.a + ((cell.b - cell.a) * (sample + 0.5)) / samples;
        const lower = safeEvaluate(cell.lowerLine, x);
        const upper = safeEvaluate(cell.upperLine, x);
        const otherLower = safeEvaluate(other.lowerLine, x);
        const otherUpper = safeEvaluate(other.upperLine, x);
        if (
          !Number.isFinite(lower) ||
          !Number.isFinite(upper) ||
          !Number.isFinite(otherLower) ||
          !Number.isFinite(otherUpper)
        ) {
          continue;
        }
        const tolerance =
          1e-5 * Math.max(1, Math.abs(otherLower), Math.abs(otherUpper));
        if (
          lower < otherLower - tolerance ||
          upper > otherUpper + tolerance
        ) {
          return false;
        }
      }
      return true;
    });
  });

  if (outerCells.length === 0) {
    throw new RegionError(
      "No enclosed region found. Add a restriction like {0 <= x <= 2}, or make a pair of curves meet at both ends.",
    );
  }

  outerCells.sort((a, b) => a.a - b.a || a.lowerLine.index - b.lowerLine.index);
  return outerCells;
}

/* -------------------------------------------------------------------------- */
/* Rotation line                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Find the single top-level "=" in a line equation. Comparisons such as <=,
 * >=, !=, and == are not equation separators, and nested brackets are ignored.
 */
function findEquationSeparator(source) {
  let depth = 0;
  let separator = -1;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character === ")" || character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character !== "=" || depth !== 0) continue;

    const previous = source[index - 1] ?? "";
    const next = source[index + 1] ?? "";
    if (previous === "<" || previous === ">" || previous === "!" || previous === "=") {
      continue;
    }
    if (next === "=") continue;
    if (separator >= 0) {
      throw new RegionError(
        "Use exactly one = in the rotation-line equation.",
      );
    }
    separator = index;
  }

  return separator;
}

/**
 * Fit A, B, C so that the input equation is A x + B y + C = 0. Sampling at
 * the origin and unit vectors gives the coefficients; extra samples verify
 * that the expression really is a straight line rather than a curve.
 */
function extractLineCoefficients(evaluate) {
  const sample = (x, y) => {
    try {
      const value = evaluate(x, y);
      return Number.isFinite(value) ? value : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };

  const atOrigin = sample(0, 0);
  const atX = sample(1, 0);
  const atY = sample(0, 1);
  if (![atOrigin, atX, atY].every(Number.isFinite)) {
    return { error: "domain" };
  }

  const a = atX - atOrigin;
  const b = atY - atOrigin;
  const c = atOrigin;
  const probes = [
    [2.3, -1.7],
    [-3.1, 2.2],
    [0.7, 4.9],
    [-2.7, -3.3],
    [5.5, 7.25],
  ];

  for (const [x, y] of probes) {
    const actual = sample(x, y);
    const predicted = a * x + b * y + c;
    if (!Number.isFinite(actual)) return { error: "domain" };
    const scale = Math.max(
      1,
      Math.abs(actual),
      Math.abs(predicted),
      Math.abs(a * x),
      Math.abs(b * y),
      Math.abs(c),
    );
    if (Math.abs(actual - predicted) > 1e-9 * scale) {
      return { error: "straight" };
    }
  }

  return { a, b, c };
}

function parseRotationLine(text) {
  const source = normalizeExpression(text);
  if (!source) {
    throw new RegionError("Enter a rotation line, for example y = 0.");
  }

  const separator = findEquationSeparator(source);
  let evaluate;
  let labelSource = source;

  if (separator >= 0) {
    const leftText = source.slice(0, separator).trim();
    const rightText = source.slice(separator + 1).trim();
    if (!leftText || !rightText) {
      throw new RegionError(
        "A rotation-line equation needs an expression on both sides of =.",
      );
    }

    let left;
    let right;
    try {
      left = compileExpression(leftText);
      right = compileExpression(rightText);
    } catch (error) {
      throw new RegionError(`Rotation line: ${error.message}`);
    }
    evaluate = (x, y) => left.evaluate(x, y) - right.evaluate(x, y);
  } else {
    let expression;
    try {
      expression = compileExpression(source);
    } catch (error) {
      throw new RegionError(`Rotation line: ${error.message}`);
    }
    if (usesVariable(expression.ast, "y")) {
      throw new RegionError(
        "Include an equals sign, for example 2x + 3y = 6.",
      );
    }
    // Keep the original shorthand: a bare expression means y = expression.
    evaluate = (x, y) => y - expression.evaluate(x, y);
    labelSource = `y = ${source}`;
  }

  const coefficients = extractLineCoefficients(evaluate);
  if (coefficients.error === "domain") {
    throw new RegionError("The rotation line must be defined everywhere.");
  }
  if (coefficients.error === "straight") {
    throw new RegionError(
      "The rotation line must be straight. Use y = mx + b, x = c, or Ax + By = C.",
    );
  }

  const { a, b, c } = coefficients;
  if (Math.hypot(a, b) < 1e-12) {
    throw new RegionError(
      "This equation does not describe a single straight line.",
    );
  }

  const label = prettyExpression(labelSource);
  const vertical =
    Math.abs(b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b), 1);

  if (vertical) {
    const x = -c / a;
    if (!Number.isFinite(x)) {
      throw new RegionError("The vertical rotation line needs a finite x-value.");
    }
    return makeAxis({
      source,
      point: { x, y: 0 },
      direction: { x: 0, y: 1 },
      label,
      kind: "vertical",
      slope: null,
      intercept: null,
    });
  }

  const slope = -a / b;
  const intercept = -c / b;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    throw new RegionError("The rotation line must have finite coordinates.");
  }
  const horizontal = Math.abs(slope) < 1e-9;

  return makeAxis({
    source,
    point: { x: 0, y: intercept },
    direction: { x: 1, y: slope },
    label,
    kind: horizontal ? "horizontal" : "oblique",
    slope,
    intercept,
  });
}

function makeAxis({ source, point, direction, label, kind, slope, intercept }) {
  const length = Math.hypot(direction.x, direction.y) || 1;
  const dx = direction.x / length;
  const dy = direction.y / length;
  const nx = -dy;
  const ny = dx;

  return {
    source,
    point,
    direction: { x: dx, y: dy },
    normal: { x: nx, y: ny },
    label,
    kind,
    slope,
    intercept,
    isHorizontal: kind === "horizontal",
    isVertical: kind === "vertical",
    uOf: (x, y) => (x - point.x) * dx + (y - point.y) * dy,
    vOf: (x, y) => (x - point.x) * nx + (y - point.y) * ny,
    pointAt: (u, v) => ({
      x: point.x + u * dx + v * nx,
      y: point.y + u * dy + v * ny,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Cell geometry                                                              */
/* -------------------------------------------------------------------------- */

function limitValue(fn, x, a, b) {
  let value = fn(x);
  if (Number.isFinite(value)) return value;
  const epsilon = Math.max(1e-9, (b - a) * 1e-8);
  value = fn(clamp(x, a + epsilon, b - epsilon));
  return Number.isFinite(value) ? value : Number.NaN;
}

function buildCellPolygon(cell) {
  if (cell.polygon) return cell.polygon;
  const points = [];
  const samples = POLYGON_SAMPLES;
  for (let index = 0; index <= samples; index++) {
    const x = cell.a + ((cell.b - cell.a) * index) / samples;
    const y = limitValue(cell.upper, x, cell.a, cell.b);
    if (Number.isFinite(y)) points.push({ x, y });
  }
  for (let index = samples; index >= 0; index--) {
    const x = cell.a + ((cell.b - cell.a) * index) / samples;
    const y = limitValue(cell.lower, x, cell.a, cell.b);
    if (Number.isFinite(y)) points.push({ x, y });
  }
  cell.polygon = points;
  return points;
}

function polygonLocal(cell, axis) {
  if (cell.polygonLocal) return cell.polygonLocal;
  const polygon = buildCellPolygon(cell);
  cell.polygonLocal = polygon.map((point) => ({
    u: axis.uOf(point.x, point.y),
    v: axis.vOf(point.x, point.y),
  }));
  return cell.polygonLocal;
}

function intervalUnion(intervals) {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    .sort((first, second) => first[0] - second[0]);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 1e-9) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }
  return merged;
}

function radialFromSignedInterval(a, b) {
  if (a > b) [a, b] = [b, a];
  if (a <= 0 && b >= 0) return [0, Math.max(-a, b)];
  return [Math.min(Math.abs(a), Math.abs(b)), Math.max(Math.abs(a), Math.abs(b))];
}

function radialMeasure(intervals) {
  let total = 0;
  for (const [inner, outer] of intervalUnion(intervals)) {
    total += outer * outer - inner * inner;
  }
  return total;
}

function cellLocalIntervalsAtU(cell, axis, u) {
  const polygon = polygonLocal(cell, axis);
  const onLine = 1e-9 * Math.max(1, Math.abs(u));

  // A horizontal sweep that just touches a local extremum is a tangency, not
  // an inside/outside change. Removing that point keeps the two lobes joined
  // at a waist instead of losing one of them.
  const tangentValues = [];
  for (let index = 0; index < polygon.length; index++) {
    const point = polygon[index];
    if (Math.abs(point.u - u) > onLine) continue;
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const next = polygon[(index + 1) % polygon.length];
    if (
      (previous.u < u - onLine && next.u < u - onLine) ||
      (previous.u > u + onLine && next.u > u + onLine)
    ) {
      tangentValues.push(point.v);
    }
  }

  const values = [];
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    if (
      (current.u <= u && next.u >= u) ||
      (current.u >= u && next.u <= u)
    ) {
      if (Math.abs(next.u - current.u) < 1e-12) continue;
      const t = (u - current.u) / (next.u - current.u);
      if (t >= -1e-9 && t <= 1 + 1e-9) {
        values.push(current.v + (next.v - current.v) * t);
      }
    }
  }
  values.sort((a, b) => a - b);
  const deduped = [];
  for (const value of values) {
    if (
      tangentValues.some(
        (tangent) =>
          Math.abs(value - tangent) <= 1e-7 * Math.max(1, Math.abs(tangent)),
      )
    ) {
      continue;
    }
    if (deduped.length === 0 || Math.abs(value - deduped.at(-1)) > 1e-7) {
      deduped.push(value);
    }
  }

  // A slice tangent to the polygon has one crossing rather than two. Keep it
  // as a zero-width interval: at a rim this preserves the rim radius instead
  // of collapsing the surface to the rotation axis.
  if (deduped.length === 0 && tangentValues.length > 0) {
    const unique = [];
    for (const value of [...tangentValues].sort((a, b) => a - b)) {
      if (
        unique.length === 0 ||
        Math.abs(value - unique.at(-1)) > 1e-7 * Math.max(1, Math.abs(value))
      ) {
        unique.push(value);
      }
    }
    return unique.map((value) => [value, value]);
  }
  if (deduped.length === 1) {
    return [[deduped[0], deduped[0]]];
  }

  const intervals = [];
  for (let index = 0; index + 1 < deduped.length; index += 2) {
    if (deduped[index + 1] - deduped[index] > 1e-9) {
      intervals.push([deduped[index], deduped[index + 1]]);
    }
  }
  return intervals;
}

function cellURange(cell, axis) {
  if (cell.uRange) return cell.uRange;
  const polygon = polygonLocal(cell, axis);
  let min = Infinity;
  let max = -Infinity;
  for (const point of polygon) {
    min = Math.min(min, point.u);
    max = Math.max(max, point.u);
  }
  cell.uRange = { min, max };
  return cell.uRange;
}

/** The single radial band a cell occupies at a coordinate along the axis. */
export function cellRadialIntervalAt(cell, axis, u) {
  if (axis.isHorizontal) {
    const point = axis.pointAt(u, 0);
    const lower = cell.lower(point.x);
    const upper = cell.upper(point.x);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    const [inner, outer] = radialFromSignedInterval(lower, upper);
    if (outer < 1e-12) return null;
    return { inner, outer, bands: [[inner, outer]] };
  }

  const intervals = cellLocalIntervalsAtU(cell, axis, u);
  const radial = intervalUnion(intervals.map(([a, b]) => radialFromSignedInterval(a, b)));
  if (radial.length === 0) return null;
  return {
    inner: radial[0][0],
    outer: radial.at(-1)[1],
    bands: radial,
  };
}

export function cellSideRadialIntervalAt(cell, axis, u, sign) {
  if (axis.isHorizontal) {
    const x = u;
    const k = axis.point.y;
    const lower = cell.lower(x) - k;
    const upper = cell.upper(x) - k;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    let inner;
    let outer;
    if (sign > 0) {
      if (upper <= 1e-9) return null;
      inner = Math.max(0, lower);
      outer = upper;
    } else {
      if (lower >= -1e-9) return null;
      inner = Math.max(0, -upper);
      outer = -lower;
    }
    if (outer < 1e-9) return null;
    return { inner, outer, bands: [[inner, outer]] };
  }

  const localIntervals = cellLocalIntervalsAtU(cell, axis, u);
  const radial = [];
  for (const [a, b] of localIntervals) {
    if (sign > 0) {
      if (b < -1e-9) continue;
      const lo = Math.max(0, a);
      const hi = Math.max(0, b);
      if (hi >= 1e-10) radial.push([lo, hi]);
    } else {
      if (a > 1e-9) continue;
      const lo = Math.max(0, -b);
      const hi = Math.max(0, -a);
      if (hi >= 1e-10) radial.push([lo, hi]);
    }
  }
  const union = intervalUnion(radial);
  if (union.length === 0) return null;
  return {
    inner: union[0][0],
    outer: union.at(-1)[1],
    bands: union,
  };
}

export function cellPolygonLocal(cell, axis) {
  return polygonLocal(cell, axis);
}

export function cellURangeFor(cell, axis) {
  return cellURange(cell, axis);
}

/* -------------------------------------------------------------------------- */
/* Volume                                                                     */
/* -------------------------------------------------------------------------- */

function horizontalRadialMeasure(cells, axis, x) {
  const intervals = [];
  const k = axis.point.y;
  for (const cell of cells) {
    if (x < cell.a - 1e-9 || x > cell.b + 1e-9) continue;
    const lower = cell.lower(x);
    const upper = cell.upper(x);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;
    const first = lower - k;
    const second = upper - k;
    intervals.push(radialFromSignedInterval(first, second));
  }
  return radialMeasure(intervals);
}

function integrateHorizontal(cells, axis) {
  const events = dedupeEvents(
    cells.flatMap((cell) => [cell.a, cell.b]),
    1e-8,
  );
  let total = 0;
  for (let index = 0; index < events.length - 1; index++) {
    const a = events[index];
    const b = events[index + 1];
    if (b - a < 1e-9) continue;
    const value = integrate(
      (x) => horizontalRadialMeasure(cells, axis, x),
      a,
      b,
      { eps: 1e-9, maxDepth: 22 },
    );
    if (Number.isFinite(value)) total += value;
  }
  return Math.PI * total;
}

function integrateAlongAxis(cells, axis) {
  let min = Infinity;
  let max = -Infinity;
  const events = [];
  for (const cell of cells) {
    const range = cellURange(cell, axis);
    min = Math.min(min, range.min);
    max = Math.max(max, range.max);
    events.push(range.min, range.max);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    return 0;
  }

  const measureAt = (u) => {
    const intervals = [];
    for (const cell of cells) {
      const range = cellURange(cell, axis);
      if (u < range.min - 1e-9 || u > range.max + 1e-9) continue;
      const localIntervals = cellLocalIntervalsAtU(cell, axis, u);
      for (const [a, b] of localIntervals) {
        intervals.push(radialFromSignedInterval(a, b));
      }
    }
    return radialMeasure(intervals);
  };

  // Adjacent cells can meet at a shared u where the cross-section changes
  // abruptly (two stacked annuli become one disk, for example). Integrating
  // straight across that seam with a fixed grid skews the volume, so break
  // the interval at every cell endpoint.
  const breaks = dedupeEvents(
    events.filter((value) => value > min + 1e-9 && value < max - 1e-9),
    1e-8,
  );
  let total = 0;
  let start = min;
  for (const end of [...breaks, max]) {
    if (end - start > 1e-9) {
      const value = integrate(measureAt, start, end, {
        eps: 1e-9,
        maxDepth: 22,
      });
      if (Number.isFinite(value)) total += value;
    }
    start = end;
  }
  return Math.PI * total;
}

function cellCrossesSymmetrically(cell, kValue) {
  let sampled = false;
  for (let sample = 1; sample <= 7; sample++) {
    const x = cell.a + ((cell.b - cell.a) * sample) / 8;
    const lower = cell.lower(x);
    const upper = cell.upper(x);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;
    const tolerance =
      1e-7 * Math.max(1, Math.abs(kValue), Math.abs(lower), Math.abs(upper));
    if (Math.abs((lower + upper) / 2 - kValue) > tolerance) return false;
    sampled = true;
  }
  return sampled;
}

function cellSideOfAxis(cell, axis) {
  if (!axis.isHorizontal) return "crosses";
  const k = axis.point.y;
  let sawAbove = false;
  let sawBelow = false;
  let sawCrossing = false;

  for (let sample = 1; sample <= 9; sample++) {
    const x = cell.a + ((cell.b - cell.a) * sample) / 10;
    const lower = cell.lower(x);
    const upper = cell.upper(x);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;
    const tolerance =
      1e-7 * Math.max(1, Math.abs(k), Math.abs(lower), Math.abs(upper));
    if (upper - lower < tolerance) continue;
    if (lower < k - tolerance && upper > k + tolerance) {
      sawCrossing = true;
    } else if (lower >= k - tolerance) {
      sawAbove = true;
    } else if (upper <= k + tolerance) {
      sawBelow = true;
    }
  }

  if (sawCrossing || (sawAbove && sawBelow)) return "crosses";
  if (sawAbove) return "above";
  if (sawBelow) return "below";
  return "crosses";
}

function radialDisplay(text, kValue, side) {
  const trimmed = String(text).trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return formatNumber(Math.abs(numeric - kValue), 6).replace("-", "−");
  }
  if (Math.abs(kValue) < 1e-9) {
    return side === "below" ? `−(${trimmed})` : trimmed;
  }
  if (side === "above") {
    return kValue < 0
      ? `(${trimmed}) + ${formatNumber(Math.abs(kValue), 6)}`
      : `(${trimmed}) − ${formatNumber(kValue, 6)}`;
  }
  if (side === "below") {
    return kValue > 0
      ? `${formatNumber(kValue, 6)} − (${trimmed})`
      : `−(${trimmed}) − ${formatNumber(Math.abs(kValue), 6)}`;
  }
  return `max(|${trimmed} − (${formatNumber(kValue, 6)})|)`;
}

/* -------------------------------------------------------------------------- */
/* Symbolic radii for vertical rotation lines                                 */
/* -------------------------------------------------------------------------- */

const SYMBOLIC_PRECEDENCE = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  "^": 3,
};

function displayNumber(value) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value - Math.E) <= 1e-9) return value < 0 ? "−e" : "e";
  if (Math.abs(value + Math.E) <= 1e-9) return "−e";
  const exact = formatExactNumber(value, {
    maxDenominator: 1000,
    tolerance: 1e-9,
  });
  if (exact) return exact;
  return formatNumber(value, 8);
}

function displayExpression(node, parentPrecedence = 0, variableName = "u") {
  if (!node) return "";
  if (node.type === "number") return displayNumber(node.value);
  if (node.type === "variable") {
    return node.name === "u" ? variableName : node.name;
  }
  if (node.type === "unary") {
    const body = displayExpression(node.value, 2, variableName);
    const text = `-${body}`;
    return 2 < parentPrecedence ? `(${text})` : text;
  }
  if (node.type === "binary") {
    const precedence = SYMBOLIC_PRECEDENCE[node.op] ?? 2;
    const left = displayExpression(node.left, precedence, variableName);
    let right;
    if (node.op === "^") {
      right = displayExpression(node.right, precedence, variableName);
      const integerExponent =
        node.right?.type === "number" && Number.isInteger(node.right.value);
      if (!integerExponent) right = `(${right})`;
    } else {
      right = displayExpression(
        node.right,
        precedence + (node.op === "-" || node.op === "/" ? 1 : 0),
        variableName,
      );
    }
    const text = `${left}${node.op}${right}`;
    return precedence < parentPrecedence ? `(${text})` : text;
  }
  if (node.type === "call") {
    const name = node.name === "cbrt" ? "cbrt" : node.name;
    const args = (node.args || []).map((argument) =>
      displayExpression(argument, 0, variableName),
    );
    return `${name}(${args.join(", ")})`;
  }
  return "";
}

function symbolicNumber(value) {
  return { type: "number", value };
}

function symbolicVariable(name) {
  return { type: "variable", name };
}

function symbolicUnary(value) {
  return simplifySymbolic({ type: "unary", op: "-", value });
}

function symbolicBinary(op, left, right) {
  return simplifySymbolic({ type: "binary", op, left, right });
}

function symbolicCall(name, args) {
  return { type: "call", name, args };
}

function symbolicValue(node) {
  if (!node || node.type !== "number" || !Number.isFinite(node.value)) {
    return null;
  }
  return node.value;
}

function evaluateSymbolic(node, u) {
  if (!node) return Number.NaN;
  if (node.type === "number") return node.value;
  if (node.type === "variable") return node.name === "u" ? u : Number.NaN;
  if (node.type === "unary") return -evaluateSymbolic(node.value, u);
  if (node.type === "binary") {
    const left = evaluateSymbolic(node.left, u);
    const right = evaluateSymbolic(node.right, u);
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
        return Number.NaN;
    }
  }
  if (node.type === "call") {
    const args = node.args.map((argument) => evaluateSymbolic(argument, u));
    switch (node.name) {
      case "sqrt":
        return Math.sqrt(args[0]);
      case "cbrt":
        return Math.cbrt(args[0]);
      case "exp":
        return Math.exp(args[0]);
      case "ln":
        return Math.log(args[0]);
      case "abs":
        return Math.abs(args[0]);
      default:
        return Number.NaN;
    }
  }
  return Number.NaN;
}

function simplifySymbolic(node) {
  if (!node) return node;
  if (node.type === "unary") {
    const value = simplifySymbolic(node.value);
    if (value.type === "number") return symbolicNumber(-value.value);
    if (value.type === "unary") return value.value;
    if (value.type === "binary" && (value.op === "+" || value.op === "-")) {
      return simplifySymbolic({
        type: "binary",
        op: value.op === "+" ? "-" : "+",
        left: symbolicUnary(value.left),
        right: value.right,
      });
    }
    return { type: "unary", op: "-", value };
  }
  if (node.type !== "binary") return node;

  const left = simplifySymbolic(node.left);
  const right = simplifySymbolic(node.right);
  const a = symbolicValue(left);
  const b = symbolicValue(right);
  if (a !== null && b !== null) {
    let value = null;
    switch (node.op) {
      case "+":
        value = a + b;
        break;
      case "-":
        value = a - b;
        break;
      case "*":
        value = a * b;
        break;
      case "/":
        value = b === 0 ? null : a / b;
        break;
      case "^":
        value = Math.pow(a, b);
        break;
      default:
        break;
    }
    if (value !== null && Number.isFinite(value)) {
      return symbolicNumber(value);
    }
    return { type: "binary", op: node.op, left, right };
  }

  if (node.op === "+") {
    if (a === 0) return right;
    if (b === 0) return left;
    if (right.type === "unary") {
      return simplifySymbolic({ type: "binary", op: "-", left, right: right.value });
    }
    if (b !== null && b < 0) {
      return simplifySymbolic({
        type: "binary",
        op: "-",
        left,
        right: symbolicNumber(-b),
      });
    }
    if (left.type === "unary" && right.type === "number") {
      return simplifySymbolic({
        type: "binary",
        op: "-",
        left: right,
        right: left.value,
      });
    }
  } else if (node.op === "-") {
    if (b === 0) return left;
    if (a === 0) return simplifySymbolic({ type: "unary", op: "-", value: right });
    if (right.type === "unary") {
      return simplifySymbolic({ type: "binary", op: "+", left, right: right.value });
    }
    if (b !== null && b < 0) {
      return simplifySymbolic({
        type: "binary",
        op: "+",
        left,
        right: symbolicNumber(-b),
      });
    }
  } else if (node.op === "*") {
    if (a === 0 || b === 0) return symbolicNumber(0);
    if (a === 1) return right;
    if (b === 1) return left;
    if (a === -1) return simplifySymbolic({ type: "unary", op: "-", value: right });
    if (b === -1) return simplifySymbolic({ type: "unary", op: "-", value: left });
  } else if (node.op === "/") {
    if (a === 0) return symbolicNumber(0);
    if (b === 1) return left;
  } else if (node.op === "^") {
    if (b === 0) return symbolicNumber(1);
    if (b === 1) return left;
    if (a === 1) return symbolicNumber(1);
  }

  return { type: "binary", op: node.op, left, right };
}

function symbolicExponentRoot(rhs, reciprocal) {
  if (Math.abs(reciprocal - 2) < 1e-9) {
    return symbolicBinary("^", rhs, symbolicNumber(2));
  }
  if (Math.abs(reciprocal - 3) < 1e-9) {
    return symbolicBinary("^", rhs, symbolicNumber(3));
  }
  if (Math.abs(reciprocal - 0.5) < 1e-9) {
    return symbolicCall("sqrt", [rhs]);
  }
  if (Math.abs(reciprocal - 1 / 3) < 1e-9) {
    return symbolicCall("cbrt", [rhs]);
  }
  if (Math.abs(reciprocal + 1) < 1e-9) {
    return symbolicBinary("/", symbolicNumber(1), rhs);
  }
  return symbolicBinary("^", rhs, symbolicNumber(reciprocal));
}

/**
 * Solve a boundary y = f(x) for x in terms of u. Only the common textbook
 * forms are supported: linear, powers, roots, exp, and ln, including nested
 * combinations such as sqrt(x - 1) + 2. A null result leaves the integral in
 * its generic R(u)/r(u) form rather than inventing an incorrect inverse.
 */
function invertExpression(node, rhs, depth = 0, variable = "x") {
  if (!node || depth > 12 || !usesVariable(node, variable)) return [];
  if (node.type === "variable") {
    return node.name === variable ? [rhs] : [];
  }
  if (node.type === "unary") {
    return invertExpression(
      node.value,
      symbolicBinary("-", symbolicNumber(0), rhs),
      depth + 1,
      variable,
    );
  }
  if (node.type === "binary") {
    const leftHas = usesVariable(node.left, variable);
    const rightHas = usesVariable(node.right, variable);
    if (leftHas === rightHas) return [];

    if (node.op === "+") {
      const next = leftHas
        ? symbolicBinary("-", rhs, node.right)
        : symbolicBinary("-", rhs, node.left);
      return invertExpression(
        leftHas ? node.left : node.right,
        next,
        depth + 1,
        variable,
      );
    }
    if (node.op === "-") {
      if (leftHas) {
        return invertExpression(
          node.left,
          symbolicBinary("+", rhs, node.right),
          depth + 1,
          variable,
        );
      }
      return invertExpression(
        node.right,
        symbolicBinary("-", node.left, rhs),
        depth + 1,
        variable,
      );
    }
    if (node.op === "*") {
      const divisor = leftHas ? node.right : node.left;
      return invertExpression(
        leftHas ? node.left : node.right,
        symbolicBinary("/", rhs, divisor),
        depth + 1,
        variable,
      );
    }
    if (node.op === "/") {
      if (leftHas) {
        return invertExpression(
          node.left,
          symbolicBinary("*", rhs, node.right),
          depth + 1,
          variable,
        );
      }
      return invertExpression(
        node.right,
        symbolicBinary("/", node.left, rhs),
        depth + 1,
        variable,
      );
    }
    if (node.op === "^") {
      if (rightHas) return [];
      const exponent = constantNumericValue(node.right);
      if (exponent === null || Math.abs(exponent) < 1e-12) return [];
      if (Math.abs(exponent - 1) < 1e-12) {
        return invertExpression(node.left, rhs, depth + 1, variable);
      }
      const reciprocal = 1 / exponent;
      const root = symbolicExponentRoot(rhs, reciprocal);
      const results = invertExpression(
        node.left,
        root,
        depth + 1,
        variable,
      );
      if (Number.isInteger(exponent) && Math.abs(exponent % 2) === 0) {
        const negativeRoot =
          Math.abs(reciprocal - 0.5) < 1e-9
            ? symbolicUnary(symbolicCall("sqrt", [rhs]))
            : Math.abs(reciprocal - 1 / 3) < 1e-9
              ? symbolicUnary(symbolicCall("cbrt", [rhs]))
              : symbolicUnary(
                  symbolicBinary("^", rhs, symbolicNumber(reciprocal)),
                );
        results.push(
          ...invertExpression(
            node.left,
            negativeRoot,
            depth + 1,
            variable,
          ),
        );
      }
      return results;
    }
    return [];
  }
  if (node.type === "call" && node.args?.length === 1) {
    const argument = node.args[0];
    if (node.name === "sqrt") {
      return invertExpression(
        argument,
        symbolicBinary("^", rhs, symbolicNumber(2)),
        depth + 1,
        variable,
      );
    }
    if (node.name === "cbrt") {
      return invertExpression(
        argument,
        symbolicBinary("^", rhs, symbolicNumber(3)),
        depth + 1,
        variable,
      );
    }
    if (node.name === "exp") {
      return invertExpression(
        argument,
        symbolicCall("ln", [rhs]),
        depth + 1,
        variable,
      );
    }
    if (node.name === "ln") {
      return invertExpression(
        argument,
        symbolicCall("exp", [rhs]),
        depth + 1,
        variable,
      );
    }
    if (node.name === "abs") {
      return [
        ...invertExpression(argument, rhs, depth + 1, variable),
        ...invertExpression(
          argument,
          symbolicUnary(rhs),
          depth + 1,
          variable,
        ),
      ];
    }
  }
  return [];
}

function affineCoefficients(node) {
  if (!node) return null;
  if (node.type === "number") {
    return Number.isFinite(node.value) ? { slope: 0, intercept: node.value } : null;
  }
  if (node.type === "variable") {
    return node.name === "x" ? { slope: 1, intercept: 0 } : null;
  }
  if (node.type === "unary") {
    const inner = affineCoefficients(node.value);
    return inner ? { slope: -inner.slope, intercept: -inner.intercept } : null;
  }
  if (node.type !== "binary") return null;
  const left = affineCoefficients(node.left);
  const right = affineCoefficients(node.right);
  if (!left || !right) return null;
  if (node.op === "+") {
    return {
      slope: left.slope + right.slope,
      intercept: left.intercept + right.intercept,
    };
  }
  if (node.op === "-") {
    return {
      slope: left.slope - right.slope,
      intercept: left.intercept - right.intercept,
    };
  }
  if (node.op === "*") {
    if (Math.abs(left.slope) < 1e-12) {
      return {
        slope: right.slope * left.intercept,
        intercept: right.intercept * left.intercept,
      };
    }
    if (Math.abs(right.slope) < 1e-12) {
      return {
        slope: left.slope * right.intercept,
        intercept: left.intercept * right.intercept,
      };
    }
    return null;
  }
  if (node.op === "/") {
    if (Math.abs(right.slope) > 1e-12 || Math.abs(right.intercept) < 1e-12) {
      return null;
    }
    return {
      slope: left.slope / right.intercept,
      intercept: left.intercept / right.intercept,
    };
  }
  if (node.op === "^") {
    if (Math.abs(left.slope) < 1e-12) {
      return {
        slope: 0,
        intercept: Math.pow(left.intercept, right.intercept),
      };
    }
    if (Math.abs(right.slope) < 1e-12 && Math.abs(right.intercept - 1) < 1e-12) {
      return left;
    }
  }
  return null;
}

function affineExpression(slope, intercept) {
  const m = Math.abs(slope) < 1e-12 ? 0 : slope;
  const b = Math.abs(intercept) < 1e-12 ? 0 : intercept;
  if (m === 0) return symbolicNumber(b);
  const term =
    Math.abs(m - 1) < 1e-12
      ? symbolicVariable("u")
      : symbolicBinary("*", symbolicNumber(m), symbolicVariable("u"));
  return b === 0 ? term : symbolicBinary("+", term, symbolicNumber(b));
}

function linePerpendicularExpression(line, axis) {
  if (!line.core) return null;
  const coefficients = affineCoefficients(line.core.ast);
  if (!coefficients) return null;
  const { slope, intercept } = coefficients;
  const denominator =
    axis.direction.x + slope * axis.direction.y;
  if (Math.abs(denominator) < 1e-12) return null;
  const u0 =
    -axis.point.x * axis.direction.x +
    (intercept - axis.point.y) * axis.direction.y;
  const v0 =
    -axis.point.x * axis.normal.x +
    (intercept - axis.point.y) * axis.normal.y;
  const v1 = axis.normal.x + slope * axis.normal.y;
  const lineSlope = v1 / denominator;
  const lineIntercept = v0 - (v1 * u0) / denominator;
  if (!Number.isFinite(lineSlope) || !Number.isFinite(lineIntercept)) {
    return null;
  }
  return affineExpression(lineSlope, lineIntercept);
}

function closurePerpendicularExpression(closure, axis) {
  const dy = axis.direction.y;
  if (Math.abs(dy) < 1e-12) return null;
  const base = closure - axis.point.x;
  const slope = axis.normal.y / dy;
  const intercept =
    base * axis.normal.x - base * axis.direction.x * slope;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  return affineExpression(slope, intercept);
}

/**
 * Candidate signed-perpendicular expressions for the two sides of a cell.
 * Vertical axes invert the curve; oblique axes can still be explicit when the
 * boundary is a straight line. Everything is checked against the cell polygon
 * before it is shown, so an unsupported boundary simply falls back to R/r.
 */
function cellRadialCandidates(cell, axis) {
  const candidates = [];
  const add = (expression) => {
    const text = displayExpression(expression);
    if (!text) return;
    if (candidates.some((entry) => entry.text === text)) return;
    candidates.push({ expression, text });
  };

  if (axis.isVertical) {
    for (const line of [cell.lowerLine, cell.upperLine]) {
      if (!line.core) continue;
      const inverses = invertExpression(line.core.ast, symbolicVariable("u"));
      for (const expression of inverses) {
        add(
          symbolicBinary(
            "*",
            symbolicBinary(
              "-",
              expression,
              symbolicNumber(axis.point.x),
            ),
            symbolicNumber(axis.normal.x),
          ),
        );
      }
    }
    for (const closure of [cell.a, cell.b]) {
      add(
        symbolicBinary(
          "*",
          symbolicBinary(
            "-",
            symbolicNumber(closure),
            symbolicNumber(axis.point.x),
          ),
          symbolicNumber(axis.normal.x),
        ),
      );
    }
    return candidates;
  }

  for (const line of [cell.lowerLine, cell.upperLine]) {
    const expression = linePerpendicularExpression(line, axis);
    if (expression) add(expression);
  }
  for (const closure of [cell.a, cell.b]) {
    const expression = closurePerpendicularExpression(closure, axis);
    if (expression) add(expression);
  }
  return candidates;
}

function localSliceInterval(cell, axis, u) {
  const intervals = cellLocalIntervalsAtU(cell, axis, u);
  if (intervals.length !== 1) return null;
  const [lo, hi] = intervals[0];
  const width = hi - lo;
  if (!(width > 1e-9)) return null;
  return { lo, hi, width };
}

function pickCandidate(candidates, u, target, width) {
  let best = null;
  for (const candidate of candidates) {
    const value = evaluateSymbolic(candidate.expression, u);
    if (!Number.isFinite(value)) continue;
    const error = Math.abs(value - target);
    if (!best || error < best.error) best = { ...candidate, error };
  }
  if (!best) return null;
  return best.error <= Math.min(0.02, width * 0.35) ? best : null;
}

function tryRadialSegment(cell, axis, start, end, candidates, variableName) {
  if (!(end - start > 1e-7)) return null;
  const fractions = [0.15, 0.32, 0.5, 0.68, 0.85];
  const samples = fractions.map((fraction) => {
    const u = start + (end - start) * fraction;
    return { u, interval: localSliceInterval(cell, axis, u) };
  });
  if (samples.some((sample) => !sample.interval)) return null;

  const middle = samples[Math.floor(samples.length / 2)].interval;
  const low = pickCandidate(candidates, samples[2].u, middle.lo, middle.width);
  const high = pickCandidate(candidates, samples[2].u, middle.hi, middle.width);
  if (!low || !high || low.text === high.text) return null;

  const sideTolerance = 1e-9 * Math.max(1, Math.abs(middle.lo), Math.abs(middle.hi));
  const positive = middle.hi > sideTolerance;
  const negative = middle.lo < -sideTolerance;
  if (positive && negative) return null;

  const lowRadius = positive
    ? low.expression
    : symbolicUnary(low.expression);
  const highRadius = positive
    ? high.expression
    : symbolicUnary(high.expression);

  let outerExpression;
  let innerExpression;
  const lowValue = evaluateSymbolic(lowRadius, samples[2].u);
  const highValue = evaluateSymbolic(highRadius, samples[2].u);
  if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) return null;
  if (lowValue >= highValue) {
    outerExpression = lowRadius;
    innerExpression = highRadius;
  } else {
    outerExpression = highRadius;
    innerExpression = lowRadius;
  }

  for (const sample of samples) {
    const { lo, hi, width } = sample.interval;
    const tolerance = 1e-9 * Math.max(1, Math.abs(lo), Math.abs(hi));
    if (lo < -tolerance && hi > tolerance) return null;
    const actual = [Math.abs(lo), Math.abs(hi)].sort((a, b) => a - b);
    const outer = evaluateSymbolic(outerExpression, sample.u);
    const inner = evaluateSymbolic(innerExpression, sample.u);
    const limit = Math.min(0.02, width * 0.35) + 1e-7;
    if (
      !Number.isFinite(outer) ||
      !Number.isFinite(inner) ||
      outer < -1e-9 ||
      inner < -1e-9 ||
      outer + 1e-9 < inner ||
      Math.abs(outer - actual[1]) > limit ||
      Math.abs(inner - actual[0]) > limit
    ) {
      return null;
    }
  }

  return {
    uStart: start,
    uEnd: end,
    outerText: displayExpression(outerExpression, 0, variableName),
    innerText: displayExpression(innerExpression, 0, variableName),
    outerExpression,
    innerExpression,
    explicit: true,
  };
}

/**
 * Express the perpendicular radii as real functions of the axis coordinate.
 * A cell can switch which boundary is active at a corner (a right triangle
 * revolved about its hypotenuse does this), so the display is split at the
 * cell's own corner heights. If a piece cannot be matched to an explicit
 * candidate the caller keeps the generic R/r notation.
 */
function perpendicularRadialSegments(cell, axis) {
  if (!cell.polygon || cell.polygon.length < 3) return null;
  const range = cellURange(cell, axis);
  if (!range || !(range.max - range.min > 1e-7)) return null;
  const candidates = cellRadialCandidates(cell, axis);
  if (candidates.length < 2) return null;

  const variableName = axis.isVertical ? "y" : "u";
  const sampleCount = 24;
  const samples = [];
  for (let index = 0; index < sampleCount; index++) {
    const fraction = 0.1 + (0.8 * (index + 0.5)) / sampleCount;
    const u = range.min + (range.max - range.min) * fraction;
    const interval = localSliceInterval(cell, axis, u);
    if (!interval) continue;
    const tolerance =
      1e-9 * Math.max(1, Math.abs(interval.lo), Math.abs(interval.hi));
    if (interval.lo < -tolerance && interval.hi > tolerance) continue;
    const low = pickCandidate(
      candidates,
      u,
      interval.lo,
      interval.width * 1.4,
    );
    const high = pickCandidate(
      candidates,
      u,
      interval.hi,
      interval.width * 1.4,
    );
    if (!low || !high || low.text === high.text) continue;
    samples.push({
      u,
      signature: `${low.text}|${high.text}`,
    });
  }

  if (samples.length === 0) return null;

  const runs = [];
  for (const sample of samples) {
    const previous = runs.at(-1);
    if (!previous || previous.signature !== sample.signature) {
      runs.push({ signature: sample.signature, first: sample, last: sample });
    } else {
      previous.last = sample;
    }
  }

  if (runs.length === 1) {
    const segment = tryRadialSegment(
      cell,
      axis,
      range.min,
      range.max,
      candidates,
      variableName,
    );
    return segment ? [segment] : null;
  }

  const xTolerance = 1e-7 * Math.max(1, Math.abs(cell.a), Math.abs(cell.b));
  const corners = [];
  for (const point of cell.polygon) {
    if (
      Math.abs(point.x - cell.a) <= xTolerance ||
      Math.abs(point.x - cell.b) <= xTolerance
    ) {
      const u = axis.uOf(point.x, point.y);
      if (u > range.min + 1e-8 && u < range.max - 1e-8) corners.push(u);
    }
  }
  corners.sort((a, b) => a - b);

  const splits = [];
  for (let index = 0; index + 1 < runs.length; index++) {
    const left = runs[index].last.u;
    const right = runs[index + 1].first.u;
    const middle = (left + right) / 2;
    const inGap = corners.filter((u) => u > left + 1e-9 && u < right - 1e-9);
    let split = middle;
    if (inGap.length > 0) {
      split = inGap.reduce((closest, u) =>
        Math.abs(u - middle) < Math.abs(closest - middle) ? u : closest,
      );
    }
    splits.push(split);
  }

  const edges = [range.min, ...splits, range.max];
  const segments = [];
  for (let index = 0; index + 1 < edges.length; index++) {
    const segment = tryRadialSegment(
      cell,
      axis,
      edges[index],
      edges[index + 1],
      candidates,
      variableName,
    );
    if (!segment) return null;
    segments.push(segment);
  }
  return segments.length > 0 ? segments : null;
}

function buildFormula(cells, axis, method, volume, exact) {
  const sides = cells.map((cell) => cellSideOfAxis(cell, axis));
  const horizontal = axis.isHorizontal;
  const sliceVariable = horizontal ? "x" : axis.isVertical ? "y" : "u";
  const exactLimit = (value) => {
    if (!Number.isFinite(value)) return false;
    // Polygon sampling can leave a tiny positive value at a true zero cusp.
    if (Math.abs(value) < 5e-4) return true;
    return Boolean(
      approximateFraction(value, {
        maxDenominator: 2000,
        tolerance: 1e-8,
      }),
    );
  };
  const terms = [];
  const pushTerm = (cell, side, uStart, uEnd, radial) => {
    terms.push({
      a: cell.a,
      b: cell.b,
      uStart,
      uEnd,
      lowerText: cell.lowerLine.source,
      upperText: cell.upperLine.source,
      side,
      outerText: radial ? radial.outerText : `R(${sliceVariable})`,
      innerText: radial ? radial.innerText : `r(${sliceVariable})`,
      explicitRadii: Boolean(radial?.explicit),
      outerExpression: radial?.outerExpression ?? null,
      innerExpression: radial?.innerExpression ?? null,
      exactLimits:
        Number.isFinite(uStart) &&
        Number.isFinite(uEnd) &&
        exactLimit(uStart) &&
        exactLimit(uEnd),
    });
  };

  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    const side = sides[index];
    if (horizontal) {
      const kValue = axis.point.y;
      const k = formatNumber(kValue, 6).replace("-", "−");
      const zeroAxis = Math.abs(kValue) < 1e-9;
      let outerText;
      let innerText;
      if (side === "above") {
        outerText = radialDisplay(cell.upperLine.source, kValue, "above");
        innerText = radialDisplay(cell.lowerLine.source, kValue, "above");
      } else if (side === "below") {
        outerText = radialDisplay(cell.lowerLine.source, kValue, "below");
        innerText = radialDisplay(cell.upperLine.source, kValue, "below");
      } else if (cellCrossesSymmetrically(cell, kValue)) {
        // A disk centred on the rotation line has the same radius above and
        // below it, so the max(...) form would be needlessly noisy.
        outerText = radialDisplay(cell.upperLine.source, kValue, "above");
        innerText = "0";
      } else {
        outerText = zeroAxis
          ? `max(|${cell.upperLine.source}|, |${cell.lowerLine.source}|)`
          : `max(|${cell.upperLine.source} − (${k})|, |${cell.lowerLine.source} − (${k})|)`;
        innerText = "0";
      }
      if (/^\(?0\)?$/.test(innerText.trim()) || /^\(?0\)?\s*[−-]\s*\(?0\)?$/.test(innerText.trim())) {
        innerText = "0";
      }
      pushTerm(cell, side, null, null, {
        outerText,
        innerText,
        explicit: false,
      });
      continue;
    }

    const segments = perpendicularRadialSegments(cell, axis);
    if (segments) {
      for (const segment of segments) {
        pushTerm(cell, side, segment.uStart, segment.uEnd, segment);
      }
    } else {
      const range = cellURange(cell, axis);
      pushTerm(cell, side, range.min, range.max, null);
    }
  }

  const note = horizontal
    ? method === "Disk method"
      ? "The region touches the rotation line, so each slice is a solid disk."
      : "The rotation line leaves a gap, so each perpendicular slice is a washer."
    : `The region is sliced perpendicular to ${axis.label}; each slice is rotated into an annulus or disk.`;

  return {
    kind: horizontal ? "horizontal" : "oblique",
    axisLabel: axis.label,
    method,
    terms,
    note,
    variable: sliceVariable,
    exact,
    volume,
  };
}

/* -------------------------------------------------------------------------- */
/* Public analysis                                                            */
/* -------------------------------------------------------------------------- */

export function analyzeLines(inputs, axisText, options = {}) {
  const usable = (inputs || []).filter((input) => String(input.text ?? "").trim());
  if (usable.length === 0) {
    return {
      ok: false,
      error: "Add at least two function lines to enclose a region.",
      lines: [],
    };
  }

  let lines;
  try {
    lines = usable.flatMap((input, index) => compileLine(input, index));
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      lineId: error.lineId ?? null,
      lines: [],
    };
  }

  if (lines.length < 2) {
    return {
      ok: false,
      error: "Add at least two function lines to enclose a region.",
      lines,
    };
  }

  const functionLines = lines.filter((line) => line.kind !== "vertical");
  const verticalXs = lines
    .filter((line) => line.kind === "vertical")
    .map((line) => line.verticalX);

  if (functionLines.length < 2) {
    return {
      ok: false,
      error:
        "Add at least two y = f(x) lines. Vertical lines such as x = 4 can close the sides, but two curves are needed for area.",
      lines,
    };
  }

  let axis;
  try {
    axis = parseRotationLine(axisText);
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      lines,
      axis: null,
    };
  }

  const window = searchWindowFor(usable, lines);
  for (const line of functionLines) scanDomain(line, window);

  let parsedCells;
  try {
    parsedCells = buildPairCells(functionLines, window, verticalXs, options);
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      lines,
      axis,
      window,
    };
  }

  // Restrict each cell to the finite part of both boundaries.
  const cells = parsedCells;
  for (const cell of cells) {
    buildCellPolygon(cell);
  }

  let volume;
  try {
    volume = axis.isHorizontal
      ? integrateHorizontal(cells, axis)
      : integrateAlongAxis(cells, axis);
  } catch (error) {
    return {
      ok: false,
      error: `Could not compute the volume: ${error.message}`,
      lines,
      axis,
      window,
      cells,
    };
  }

  if (!Number.isFinite(volume) || volume <= 1e-9) {
    return {
      ok: false,
      error: "The enclosed region has zero volume about that rotation line.",
      lines,
      axis,
      window,
      cells,
    };
  }

  let method;
  if (!axis.isHorizontal) {
    method = "Perpendicular slicing";
  } else {
    const hasInner = cells.some((cell) => {
      const x = (cell.a + cell.b) / 2;
      const lower = cell.lower(x);
      const upper = cell.upper(x);
      const k = axis.point.y;
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) return false;
      const distances = [Math.abs(lower - k), Math.abs(upper - k)];
      const crosses = lower <= k && upper >= k;
      return !crosses && Math.min(...distances) > 1e-6;
    });
    method = hasInner ? "Washer method" : "Disk method";
  }

  const exactCandidates = functionLines.every((line) => {
    if (line.polynomial) return true;
    return (
      axis.isHorizontal &&
      Math.abs(axis.point.y) < 1e-9 &&
      line.squarePolynomial
    );
  });
  const rationalEndpoint = (value) =>
    Boolean(
      approximateFraction(value, {
        maxDenominator: 2000,
        tolerance: 1e-8,
      }),
    );
  // Polygon samples can land a hair inside a cusp, so the slice limits may be
  // 1e-4 instead of 0. Accept those as the exact rational endpoint they mean.
  const displayRationalEndpoint = (value) =>
    Boolean(
      approximateFraction(value, {
        maxDenominator: 2000,
        tolerance: 1e-3,
      }),
    );
  const exactLabel = (fraction) => ({
    numerator: fraction.numerator,
    denominator: fraction.denominator,
    label:
      fraction.denominator === 1
        ? `${fraction.numerator}π`
        : Math.abs(fraction.numerator) === 1
          ? `${fraction.numerator < 0 ? "−" : ""}π/${fraction.denominator}`
          : `${fraction.numerator}π/${fraction.denominator}`,
  });
  const piSurdLabel = (source) => {
    const trimmed = String(source).trim();
    if (!trimmed) return null;
    let sign = "";
    let body = trimmed;
    if (body.startsWith("−") || body.startsWith("-")) {
      sign = "−";
      body = body.slice(1);
    }
    const insertPi = (part) => {
      if (/^√/.test(part)) return `π${part}`;
      if (/^\d+√/.test(part)) return part.replace(/^(\d+)(√.*)$/, "$1π$2");
      if (/^\d+$/.test(part)) return `${part}π`;
      return `π(${part})`;
    };
    const slash = body.lastIndexOf("/");
    if (slash > 0) {
      const numerator = body.slice(0, slash);
      const denominator = body.slice(slash + 1);
      return `${sign}${insertPi(numerator)}/${denominator}`;
    }
    return `${sign}${insertPi(body)}`;
  };

  const formula = buildFormula(cells, axis, method, volume, null);

  let exact = null;
  if (
    axis.isHorizontal &&
    exactCandidates &&
    cells.every(
      (cell) =>
        cell.polygon &&
        cell.polygon.length > 4 &&
        rationalEndpoint(cell.a) &&
        rationalEndpoint(cell.b),
    )
  ) {
    const fraction = approximateFraction(volume / Math.PI, {
      maxDenominator: 5000,
      tolerance: 1e-6,
    });
    if (fraction) exact = exactLabel(fraction);
  }

  if (!axis.isHorizontal && axis.isVertical) {
    const symbolicTerms = formula.terms.every(
      (term) =>
        term.explicitRadii &&
        term.outerExpression &&
        term.innerExpression &&
        term.exactLimits &&
        isPolynomialIn(term.outerExpression, "u") &&
        isPolynomialIn(term.innerExpression, "u") &&
        displayRationalEndpoint(term.uStart) &&
        displayRationalEndpoint(term.uEnd),
    );
    if (symbolicTerms) {
      const fraction = approximateFraction(volume / Math.PI, {
        maxDenominator: 5000,
        tolerance: 1e-5,
      });
      if (fraction) exact = exactLabel(fraction);
    }
  }

  if (!exact) {
    // Recognize simple radical coefficients too, such as the pi * sqrt(2) / 6
    // volume of a right triangle revolved about its hypotenuse.
    const surd = formatExactNumber(volume / Math.PI, {
      maxDenominator: 200,
      tolerance: axis.isHorizontal ? 1e-7 : 1e-6,
      allowPi: false,
      allowSqrt: true,
    });
    if (surd && surd.includes("√")) {
      const radicands = [...surd.matchAll(/√(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      // Reject the large, accidental radicands the recognizer can produce when
      // it fits a square to an irrational-looking numeric volume.
      if (
        radicands.length > 0 &&
        radicands.every((value) => Number.isFinite(value) && value <= 200)
      ) {
        const label = piSurdLabel(surd);
        if (label) exact = { label, expression: true };
      }
    }
  }
  formula.exact = exact;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const cell of cells) {
    xMin = Math.min(xMin, cell.a);
    xMax = Math.max(xMax, cell.b);
    for (const point of cell.polygon) {
      yMin = Math.min(yMin, point.y);
      yMax = Math.max(yMax, point.y);
    }
  }

  // A horizontal rotation line is part of the region's vertical extent, so
  // show it. Other axes are drawn across the whole viewport and must not
  // inflate the graph bounds with their far-away endpoints.
  if (axis.isHorizontal) {
    yMin = Math.min(yMin, axis.point.y);
    yMax = Math.max(yMax, axis.point.y);
  }

  for (const value of verticalXs) {
    if (value >= xMin - (xMax - xMin) * 0.25 && value <= xMax + (xMax - xMin) * 0.25) {
      xMin = Math.min(xMin, value);
      xMax = Math.max(xMax, value);
    }
  }

  const xPadding = Math.max((xMax - xMin) * 0.08, 0.25);
  const yPadding = Math.max((yMax - yMin) * 0.12, 0.3);

  return {
    ok: true,
    lines,
    axis,
    cells,
    window,
    volume,
    exact,
    method,
    formula,
    bounds: {
      xMin: xMin - xPadding,
      xMax: xMax + xPadding,
      yMin: yMin - yPadding,
      yMax: yMax + yPadding,
    },
    regionBounds: { xMin, xMax, yMin, yMax },
  };
}

export function prettyExpression(value) {
  return String(value ?? "")
    .replace(/\bpi\b/g, "π")
    .replace(/\btau\b/g, "τ")
    .replace(/\bsqrt\s*\(/g, "√(")
    .replace(/\bcbrt\s*\(/g, "∛(")
    .replace(/\*/g, " · ")
    .replace(/\^2\b/g, "²")
    .replace(/\^3\b/g, "³")
    .replace(/\^4\b/g, "⁴")
    .replace(/-/g, "−")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatBound(value, maxDecimals = 6) {
  return (
    formatExactNumber(value) ??
    formatNumber(value, maxDecimals).replace("-", "−")
  );
}
