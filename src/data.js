export const f = (x) => -x * x + 4 * x;

export const DOMAIN = { x0: 0, x1: 4 };

const TAU = Math.PI * 2;

function derivative(fn) {
  const h = 1e-5;
  return (x) => (fn(x + h) - fn(x - h)) / (2 * h);
}

const outerDisk = (x) => f(x);
const innerDisk = () => 0;

const outerAboutMinusOne = (x) => f(x) + 1;
const innerAboutMinusOne = () => 1;

const outerAboutFive = () => 5;
const innerAboutFive = (x) => 5 - f(x);

export const CASES = [
  {
    id: "a",
    letter: "A",
    axisValue: 0,
    axisName: "x-axis",
    axisFormula: "y = 0",
    title: "About the x-axis",
    subtitle: "A clean disk stack",
    method: "Disk method",
    methodShort: "DISK",
    startAngle: 0,
    outer: outerDisk,
    inner: innerDisk,
    outerDerivative: derivative(outerDisk),
    innerDerivative: derivative(innerDisk),
    maxRadius: 4,
    domain: { x0: 0, x1: 4 },
    fraction: ["512π", "15"],
    volume: (512 * Math.PI) / 15,
    radiusSummary: "R(x) = −x² + 4x",
    caption: "Every cross-section perpendicular to the axis is a solid disk.",
    integral:
      "V = π ∫₀⁴ (−x² + 4x)² dx",
    expansion:
      "= π ∫₀⁴ (x⁴ − 8x³ + 16x²) dx",
    result: "= 512π / 15",
    approximationFormula:
      "Σ π [ f(xᵢ) ]² Δx",
    accent: "#43d9c2",
    accentRgb: "67, 217, 194",
    note:
      "The region touches the axis, so every cross-section is a solid disk. The parabola gives a radius that starts at zero, swells to 4, then returns to zero.",
  },
  {
    id: "b",
    letter: "B",
    axisValue: -1,
    axisName: "the line y = −1",
    axisFormula: "y = −1",
    title: "About y = −1",
    subtitle: "A washer with a hollow core",
    method: "Washer method",
    methodShort: "WASHER",
    startAngle: 0,
    outer: outerAboutMinusOne,
    inner: innerAboutMinusOne,
    outerDerivative: derivative(outerAboutMinusOne),
    innerDerivative: derivative(innerAboutMinusOne),
    maxRadius: 5,
    domain: { x0: 0, x1: 4 },
    fraction: ["832π", "15"],
    volume: (832 * Math.PI) / 15,
    radiusSummary: "R = f(x) + 1  ·  r = 1",
    caption: "A radius-1 cylinder is removed from the centre of every slice.",
    integral:
      "V = π ∫₀⁴ [ (−x² + 4x + 1)² − 1 ] dx",
    expansion:
      "= π ∫₀⁴ (x⁴ − 8x³ + 14x² + 8x) dx",
    result: "= 832π / 15",
    approximationFormula:
      "Σ π [ (f(xᵢ)+1)² − 1 ] Δx",
    accent: "#f4a259",
    accentRgb: "244, 162, 89",
    note:
      "The axis sits one unit below the region, so a cylinder of radius 1 is removed from every slice. That empty core is why this is a washer rather than a disk.",
  },
  {
    id: "c",
    letter: "C",
    axisValue: 5,
    axisName: "the line y = 5",
    axisFormula: "y = 5",
    title: "About y = 5",
    subtitle: "A cylindrical shell with a parabolic bore",
    method: "Washer method",
    methodShort: "WASHER",
    startAngle: Math.PI,
    outer: outerAboutFive,
    inner: innerAboutFive,
    outerDerivative: derivative(outerAboutFive),
    innerDerivative: derivative(innerAboutFive),
    maxRadius: 5,
    domain: { x0: 0, x1: 4 },
    fraction: ["1088π", "15"],
    volume: (1088 * Math.PI) / 15,
    radiusSummary: "R = 5  ·  r = 5 − f(x)",
    caption: "The outside radius stays at 5; the curve carves the inner bore.",
    integral:
      "V = π ∫₀⁴ [ 25 − (5 − (−x² + 4x))² ] dx",
    expansion:
      "= π ∫₀⁴ (10(−x² + 4x) − (−x² + 4x)²) dx",
    result: "= 1088π / 15",
    approximationFormula:
      "Σ π [ 25 − (5 − f(xᵢ))² ] Δx",
    accent: "#c5a3ff",
    accentRgb: "197, 163, 255",
    note:
      "The axis is above the region. The outside radius is fixed at 5, while the inside radius follows the gap between y = 5 and the curve, carving a parabolic bore.",
  },
];

export const CASE_BY_ID = Object.fromEntries(CASES.map((c) => [c.id, c]));

export function approximateVolume(problem, n, sample = "midpoint") {
  const x0 = problem.domain?.x0 ?? 0;
  const x1 = problem.domain?.x1 ?? 4;
  const dx = (x1 - x0) / n;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const x = x0 + (i + (sample === "midpoint" ? 0.5 : 1)) * dx;
    const ro = problem.outer(x);
    const ri = problem.inner(x);
    total += Math.PI * (ro * ro - ri * ri) * dx;
  }
  return total;
}

export function revolvePoint(x, radius, phi, axisValue) {
  return {
    x,
    y: axisValue + radius * Math.cos(phi),
    z: radius * Math.sin(phi),
  };
}

export { TAU };
