import {
  compileConstant,
  compileExpression,
  formatNumber,
  integrate,
} from "./expression.js";

const SAMPLE_COUNT = 401;

function numericDerivative(fn) {
  const h = 1e-5;
  return (x) => (fn(x + h) - fn(x - h)) / (2 * h);
}

function prettyExpression(value) {
  return String(value)
    .replace(/\bsqrt\s*\(/g, "√(")
    .replace(/\bpi\b/g, "π")
    .replace(/\*/g, " · ")
    .replace(/\^2\b/g, "²")
    .replace(/\^3\b/g, "³")
    .replace(/-/g, "−")
    .replace(/\s+/g, " ")
    .trim();
}

function prettyBound(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const specialValues = [
    [0, "0"],
    [Math.PI, "π"],
    [-Math.PI, "−π"],
    [Math.PI / 2, "π/2"],
    [-Math.PI / 2, "−π/2"],
    [Math.PI / 3, "π/3"],
    [-Math.PI / 3, "−π/3"],
    [Math.PI / 4, "π/4"],
    [-Math.PI / 4, "−π/4"],
    [(2 * Math.PI) / 3, "2π/3"],
    [-(2 * Math.PI) / 3, "−2π/3"],
    [Math.PI * 2, "2π"],
    [-Math.PI * 2, "−2π"],
  ];
  for (const [special, label] of specialValues) {
    if (Math.abs(number - special) < 1e-6 * Math.max(1, Math.abs(special))) {
      return label;
    }
  }
  return formatNumber(number, 6).replace("-", "−");
}

function sampleRange(a, b, count = SAMPLE_COUNT) {
  const values = [];
  for (let i = 0; i <= count; i++) {
    values.push(a + ((b - a) * i) / count);
  }
  return values;
}

export function buildCustomProblem(form) {
  const upperText = String(form.upper ?? "").trim();
  const lowerText = String(form.lower ?? "").trim() || "0";
  if (!upperText) {
    throw new Error("Enter an upper boundary equation.");
  }
  if (upperText.length > 300 || lowerText.length > 300) {
    throw new Error("Boundary expressions are too long.");
  }

  const xMinValue = compileConstant(form.xMin).value;
  const xMaxValue = compileConstant(form.xMax).value;
  const axisValue = compileConstant(form.axis).value;

  if (!(xMaxValue > xMinValue)) {
    throw new Error("The upper x-bound must be greater than the lower x-bound.");
  }
  if (xMaxValue - xMinValue > 100) {
    throw new Error("That interval is too large for this viewport. Keep it under 100 units.");
  }

  const upperExpression = compileExpression(upperText);
  const lowerExpression = compileExpression(lowerText);

  const xs = sampleRange(xMinValue, xMaxValue);
  const upperValues = [];
  const lowerValues = [];

  for (const x of xs) {
    const upperValue = upperExpression.evaluate(x);
    const lowerValue = lowerExpression.evaluate(x);
    if (!Number.isFinite(upperValue) || !Number.isFinite(lowerValue)) {
      throw new Error(
        "One of the boundaries is undefined somewhere on that x-interval.",
      );
    }
    upperValues.push(upperValue);
    lowerValues.push(lowerValue);
  }

  const maxMagnitude = Math.max(
    1,
    ...upperValues.map(Math.abs),
    ...lowerValues.map(Math.abs),
  );
  const tolerance = 1e-6 * maxMagnitude;
  const differences = upperValues.map((value, index) => value - lowerValues[index]);
  const minDifference = Math.min(...differences);
  const maxDifference = Math.max(...differences);

  let upper = upperExpression;
  let lower = lowerExpression;
  let upperDisplay = upperExpression.source;
  let lowerDisplay = lowerExpression.source;
  let upperSample = upperValues;
  let lowerSample = lowerValues;

  if (maxDifference <= tolerance) {
    upper = lowerExpression;
    lower = upperExpression;
    upperDisplay = lowerExpression.source;
    lowerDisplay = upperExpression.source;
    upperSample = lowerValues;
    lowerSample = upperValues;
  } else if (minDifference < -tolerance) {
    throw new Error(
      "The boundaries cross inside the interval. Split the region at the intersection and render a single interval.",
    );
  }

  const minLower = Math.min(...lowerSample);
  const maxUpper = Math.max(...upperSample);
  const lowerTolerance = 1e-7 * Math.max(1, Math.abs(axisValue));
  const belowRegion = axisValue <= minLower + lowerTolerance;
  const aboveRegion = axisValue >= maxUpper - lowerTolerance;

  if (!belowRegion && !aboveRegion) {
    throw new Error(
      "The rotation line passes through the region. Move it fully above or below the boundaries (touching an edge is okay).",
    );
  }
  if (belowRegion && aboveRegion) {
    throw new Error("The region has zero thickness on this interval.");
  }

  const outer = belowRegion
    ? (x) => upper.evaluate(x) - axisValue
    : (x) => axisValue - lower.evaluate(x);
  const inner = belowRegion
    ? (x) => lower.evaluate(x) - axisValue
    : (x) => axisValue - upper.evaluate(x);

  const outerSamples = xs.map(outer);
  const innerSamples = xs.map(inner);
  if (
    outerSamples.some((value) => !Number.isFinite(value) || value < -1e-8) ||
    innerSamples.some((value) => !Number.isFinite(value) || value < -1e-8)
  ) {
    throw new Error("The generated radii are not valid for this rotation line.");
  }

  const maxRadius = Math.max(...outerSamples.map((value) => Math.abs(value)));
  const maxInner = Math.max(...innerSamples.map((value) => Math.abs(value)));
  if (!(maxRadius > 1e-6)) {
    throw new Error("The region is too thin to render.");
  }

  let volume;
  try {
    volume = integrate(
      (x) => {
        const ro = Math.max(0, outer(x));
        const ri = Math.max(0, inner(x));
        return Math.PI * (ro * ro - ri * ri);
      },
      xMinValue,
      xMaxValue,
      { eps: 1e-8 },
    );
  } catch (error) {
    throw new Error(`Could not integrate the volume: ${error.message}`);
  }
  if (!Number.isFinite(volume) || volume <= 0) {
    throw new Error("The generated volume is not positive.");
  }

  const isWasher = maxInner > 1e-5;
  const startAngle = belowRegion ? 0 : Math.PI;
  const axisNumber = formatNumber(axisValue);
  const axisLabel = prettyBound(axisValue);
  const startLabel = prettyBound(xMinValue);
  const endLabel = prettyBound(xMaxValue);
  const method = isWasher ? "Washer method" : "Disk method";
  const methodShort = isWasher ? "WASHER" : "DISK";

  let outerDisplay;
  let innerDisplay;
  if (belowRegion) {
    outerDisplay =
      Math.abs(axisValue) < 1e-10
        ? upperDisplay
        : `(${upperDisplay}) - (${axisNumber})`;
    innerDisplay =
      Math.abs(axisValue) < 1e-10
        ? lowerDisplay
        : `(${lowerDisplay}) - (${axisNumber})`;
  } else {
    outerDisplay = `(${axisNumber}) - (${lowerDisplay})`;
    innerDisplay = `(${axisNumber}) - (${upperDisplay})`;
  }

  const radiusSummary = isWasher
    ? `R = ${prettyExpression(outerDisplay)}  ·  r = ${prettyExpression(
        innerDisplay,
      )}`
    : `R = ${prettyExpression(outerDisplay)}`;
  const integral = isWasher
    ? `V = π ∫_{${startLabel}}^{${endLabel}} [ R(x)² − r(x)² ] dx`
    : `V = π ∫_{${startLabel}}^{${endLabel}} R(x)² dx`;
  const approximationFormula = isWasher
    ? "Σ π [ R(xᵢ)² − r(xᵢ)² ] Δx"
    : "Σ π [ R(xᵢ) ]² Δx";
  const explanation = String(form.explanation ?? "").trim();
  const fallbackNote =
    "This solid was generated from the supplied boundaries and rotation line. Its volume is evaluated numerically with adaptive Simpson integration.";
  const note = explanation || fallbackNote;
  const requestedName = String(form.name ?? "").trim();
  const title = requestedName || "Custom solid";
  const regionEquation = `${prettyExpression(
    lowerDisplay,
  )} ≤ y ≤ ${prettyExpression(upperDisplay)}`;

  const variant = {
    id: "custom",
    letter: "A",
    title: `About y = ${axisLabel}`,
    axisValue,
    axisName: `the line y = ${axisLabel}`,
    axisFormula: `y = ${axisLabel}`,
    subtitle: "Generated from a custom region",
    method,
    methodShort,
    startAngle,
    outer,
    inner,
    outerDerivative: numericDerivative(outer),
    innerDerivative: numericDerivative(inner),
    maxRadius,
    fraction: null,
    volume,
    radiusSummary,
    integral,
    expansion: "",
    approximationFormula,
    caption: isWasher
      ? "The rotation line creates a hollow core, so slices are washers."
      : "The rotation line touches the region, so slices are disks.",
    note,
    domain: { x0: xMinValue, x1: xMaxValue },
    accent: "#43d9c2",
    accentRgb: "67, 217, 194",
    result: `≈ ${volume.toFixed(4)} u³`,
  };

  const problem = {
    id: "custom",
    source: "custom",
    title,
    shortLabel: "Custom problem",
    kicker: "CUSTOM STUDY",
    aboutTitle: "One region.<br />One axis.",
    region: {
      equation: regionEquation,
      domainLabel: `${startLabel} ≤ x ≤ ${endLabel}`,
      description: explanation || fallbackNote,
    },
    variants: [variant],
    raw: {
      upper: upperDisplay,
      lower: lowerDisplay,
      xMin: xMinValue,
      xMax: xMaxValue,
      axis: axisValue,
      question: String(form.question ?? "").trim(),
      explanation,
    },
  };

  return { problem, variant };
}
