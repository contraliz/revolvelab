import {
  approximateFraction,
  compileExpression,
  containsRestriction,
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
const VOLUME_SLICES = 2400;
const EPS = 1e-9;

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
  }
  return false;
}

function compileLine(input, index) {
  const raw = String(input.text ?? "").trim();
  if (!raw) return null;

  const stripped = stripFunctionPrefix(raw);
  if (!stripped) {
    throw new RegionError("Enter a function after y =.", input.id);
  }

  const { core, restrictions } = splitTrailingRestrictions(stripped);
  if (!core) {
    throw new RegionError("This line does not contain a function.", input.id);
  }

  let coreExpression;
  try {
    coreExpression = compileExpression(core);
  } catch (error) {
    throw new RegionError(error.message, input.id);
  }

  if (usesVariable(coreExpression.ast, "y")) {
    throw new RegionError(
      "Use y = f(x) for a boundary. Implicit equations with y on both sides are not supported.",
      input.id,
    );
  }

  if (coreExpression.ast.type === "compare") {
    throw new RegionError(
      "This is a condition, not a function. Enter y = f(x), then add a restriction like {0 <= x <= 2}.",
      input.id,
    );
  }

  const restrictionExpressions = [];
  for (const text of restrictions) {
    try {
      const compiled = compileExpression(text);
      restrictionExpressions.push(compiled);
    } catch (error) {
      throw new RegionError(`Restriction: ${error.message}`, input.id);
    }
  }

  const evaluate = (x) => {
    let value = coreExpression.evaluate(x, 0);
    if (!Number.isFinite(value)) return Number.NaN;
    for (const restriction of restrictionExpressions) {
      const allowed = restriction.evaluate(x, value);
      if (!allowed || Number.isNaN(allowed)) return Number.NaN;
    }
    return value;
  };

  const source = core.trim();
  return {
    id: input.id,
    index,
    raw,
    color: input.color,
    source,
    core: coreExpression,
    restrictions: restrictionExpressions,
    evaluate,
    polynomial:
      isPolynomialIn(coreExpression.ast) &&
      !/\b(?:pi|tau|e)\b/i.test(source),
    squarePolynomial:
      isSquarePolynomial(coreExpression.ast) &&
      !/\b(?:pi|tau|e)\b/i.test(source),
    hasRestriction:
      restrictionExpressions.length > 0 || containsRestriction(coreExpression.ast),
  };
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

function pairEndpointClosed(cell, endpoint, side) {
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

  const eventTolerance = Math.max(1e-7, cell.span * 1e-6);
  for (const line of [cell.lowerLine, cell.upperLine]) {
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

function pairCellSegments(first, second, window) {
  const events = [];
  for (const line of [first, second]) {
    for (const run of line.domainRuns) {
      if (run.closedLeft) events.push(run.a);
      if (run.closedRight) events.push(run.b);
    }
  }
  events.push(...findIntersections(first, second, window));

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

function buildPairCells(lines, window) {
  const cells = [];

  for (let first = 0; first < lines.length; first++) {
    for (let second = first + 1; second < lines.length; second++) {
      const segments = pairCellSegments(lines[first], lines[second], window);
      for (const segment of segments) {
        if (segment.b - segment.a < 1e-7) continue;
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
          !pairEndpointClosed(cell, cell.a, "left") ||
          !pairEndpointClosed(cell, cell.b, "right")
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

function formatAxisValue(value) {
  return formatNumber(value, 6).replace("-", "−");
}

function parseRotationLine(text) {
  const source = normalizeExpression(text);
  if (!source) {
    throw new RegionError("Enter a rotation line, for example y = 0.");
  }

  const verticalMatch = source.match(/^\s*x\s*=\s*(.+)$/i);
  if (verticalMatch) {
    const value = compileExpression(verticalMatch[1], { allowVariable: false });
    const x = value.evaluate(0, 0);
    if (!Number.isFinite(x)) {
      throw new RegionError("The vertical rotation line needs a finite x-value.");
    }
    return makeAxis({
      source,
      point: { x, y: 0 },
      direction: { x: 0, y: 1 },
      label: `x = ${formatAxisValue(x)}`,
      kind: "vertical",
      slope: null,
      intercept: null,
    });
  }

  const rhs = source.replace(/^\s*y\s*=\s*/i, "");
  let expression;
  try {
    expression = compileExpression(rhs);
  } catch (error) {
    throw new RegionError(`Rotation line: ${error.message}`);
  }
  if (usesVariable(expression.ast, "y")) {
    throw new RegionError(
      "Use y = mx + b or x = c for the rotation line.",
    );
  }

  const evaluate = (x) => {
    const value = expression.evaluate(x, 0);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const x0 = 0;
  const x1 = 1;
  const x2 = -2.7;
  const y0 = evaluate(x0);
  const y1 = evaluate(x1);
  const y2 = evaluate(x2);
  if (![y0, y1, y2].every(Number.isFinite)) {
    throw new RegionError("The rotation line must be defined everywhere.");
  }
  const slope = y1 - y0;
  const predicted = y0 + slope * (x2 - x0);
  if (Math.abs(predicted - y2) > 1e-7 * Math.max(1, Math.abs(y2))) {
    throw new RegionError(
      "The rotation line must be straight. Use y = mx + b or x = c.",
    );
  }

  const horizontal = Math.abs(slope) < 1e-9;
  const intercept = y0 - slope * x0;
  let label;
  if (horizontal) {
    label = `y = ${formatAxisValue(intercept)}`;
  } else {
    const slopeText =
      Math.abs(slope - 1) < 1e-9
        ? ""
        : Math.abs(slope + 1) < 1e-9
          ? "−"
          : formatAxisValue(slope);
    label = `y = ${slopeText}x`;
    if (Math.abs(intercept) > 1e-9) {
      label += ` ${intercept > 0 ? "+" : "−"} ${formatAxisValue(
        Math.abs(intercept),
      )}`;
    }
  }

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
    if (deduped.length === 0 || Math.abs(value - deduped.at(-1)) > 1e-7) {
      deduped.push(value);
    }
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
    if (outer - inner < 1e-12) return null;
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

function integrateWithSlices(fn, a, b, slices = VOLUME_SLICES) {
  const count = slices % 2 === 0 ? slices : slices + 1;
  const step = (b - a) / count;
  let sum = fn(a) + fn(b);
  for (let index = 1; index < count; index++) {
    sum += (index % 2 === 1 ? 4 : 2) * fn(a + index * step);
  }
  return (step / 3) * sum;
}

function integrateAlongAxis(cells, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const cell of cells) {
    const range = cellURange(cell, axis);
    min = Math.min(min, range.min);
    max = Math.max(max, range.max);
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

  return Math.PI * integrateWithSlices(measureAt, min, max);
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

function buildFormula(cells, axis, method, volume, exact) {
  const sides = cells.map((cell) => cellSideOfAxis(cell, axis));
  const horizontal = axis.isHorizontal;
  const terms = cells.map((cell, index) => {
    const side = sides[index];
    const lowerText = cell.lowerLine.source;
    const upperText = cell.upperLine.source;
    let outerText;
    let innerText;
    if (horizontal) {
      const kValue = axis.point.y;
      const k = formatNumber(kValue, 6).replace("-", "−");
      if (side === "above") {
        outerText = radialDisplay(upperText, kValue, "above");
        innerText = radialDisplay(lowerText, kValue, "above");
      } else if (side === "below") {
        outerText = radialDisplay(lowerText, kValue, "below");
        innerText = radialDisplay(upperText, kValue, "below");
      } else {
        outerText = zeroAxis
          ? `max(|${upperText}|, |${lowerText}|)`
          : `max(|${upperText} − (${k})|, |${lowerText} − (${k})|)`;
        innerText = "0";
      }
      if (/^\(?0\)?$/.test(innerText.trim()) || /^\(?0\)?\s*[−-]\s*\(?0\)?$/.test(innerText.trim())) {
        innerText = "0";
      }
    } else {
      outerText = `R(u)`;
      innerText = `r(u)`;
    }
    const axisRange = horizontal ? null : cellURange(cell, axis);
    return {
      a: cell.a,
      b: cell.b,
      uStart: axisRange ? axisRange.min : null,
      uEnd: axisRange ? axisRange.max : null,
      lowerText,
      upperText,
      side,
      outerText,
      innerText,
    };
  });

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
    exact,
    volume,
  };
}

/* -------------------------------------------------------------------------- */
/* Public analysis                                                            */
/* -------------------------------------------------------------------------- */

export function analyzeLines(inputs, axisText) {
  const usable = (inputs || []).filter((input) => String(input.text ?? "").trim());
  if (usable.length < 2) {
    return {
      ok: false,
      error: "Add at least two function lines to enclose a region.",
      lines: [],
    };
  }

  let lines;
  try {
    lines = usable
      .map((input, index) => compileLine(input, index))
      .filter(Boolean);
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
  for (const line of lines) scanDomain(line, window);

  let parsedCells;
  try {
    parsedCells = buildPairCells(lines, window);
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

  let exact = null;
  const exactCandidates = lines.every((line) => {
    if (line.polynomial) return true;
    return axis.isHorizontal && Math.abs(axis.point.y) < 1e-9 && line.squarePolynomial;
  });
  if (axis.isHorizontal && exactCandidates && cells.every((cell) => cell.polygon && cell.polygon.length > 4)) {
    const fraction = approximateFraction(volume / Math.PI, {
      maxDenominator: 5000,
      tolerance: 1e-6,
    });
    if (fraction) {
      exact = {
        numerator: fraction.numerator,
        denominator: fraction.denominator,
        label:
          fraction.denominator === 1
            ? `${fraction.numerator}π`
            : Math.abs(fraction.numerator) === 1
              ? `${fraction.numerator < 0 ? "−" : ""}π/${fraction.denominator}`
              : `${fraction.numerator}π/${fraction.denominator}`,
      };
    }
  }

  const formula = buildFormula(cells, axis, method, volume, exact);

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

  if (axis.isHorizontal) {
    yMin = Math.min(yMin, axis.point.y);
    yMax = Math.max(yMax, axis.point.y);
  } else {
    const first = axis.pointAt(-window.span, 0);
    const second = axis.pointAt(window.span, 0);
    yMin = Math.min(yMin, first.y, second.y);
    yMax = Math.max(yMax, first.y, second.y);
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
    .replace(/\*/g, " · ")
    .replace(/\^2\b/g, "²")
    .replace(/\^3\b/g, "³")
    .replace(/\^4\b/g, "⁴")
    .replace(/-/g, "−")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatBound(value, maxDecimals = 6) {
  return formatNumber(value, maxDecimals).replace("-", "−");
}
