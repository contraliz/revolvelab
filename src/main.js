import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CASES, approximateVolume } from "./data.js";
import { createRevolvedSolid, createWashers } from "./solid.js";
import { buildCustomProblem } from "./custom-problem.js";
import { formatNumber } from "./expression.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const DEG = Math.PI / 180;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const numberFormat = new Intl.NumberFormat("en-US");

const viewport = $("#viewport");
const canvas = $("#sceneCanvas");

const state = {
  activeCaseId: null,
  mode: "solid",
  angle: 360,
  approx: false,
  slices: 24,
  playing: false,
  grid: true,
  tool: "orbit",
};

const PRESET_PROBLEM = {
  id: "preset",
  source: "preset",
  title: "Parabolic cap",
  shortLabel: "Parabolic cap",
  kicker: "VOLUME STUDY 01",
  aboutTitle: "One region.<br />Three axes.",
  region: {
    equation: "y = −x² + 4x",
    domainLabel: "0 ≤ x ≤ 4 · 0 ≤ y ≤ f(x)",
    description:
      "The bounded region between y = −x² + 4x and the x-axis, rotated about three different horizontal lines.",
  },
  variants: CASES,
};

const problemRegistry = new Map([["preset", PRESET_PROBLEM]]);
let currentProblem = PRESET_PROBLEM;
let currentProblemVariants = new Map(CASES.map((item) => [item.id, item]));
let solidSets = {};
let activeSolid = null;
let activeCase = null;
let washerGroup = null;
let washerTimer = 0;
let introAnimation = null;
let cameraTween = null;
let toastTimer = 0;
let aiRequestSerial = 0;
let lastTime = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let lastTriangleUpdate = 0;

/* -------------------------------------------------------------------------- */
/* Renderer, scene, and cameras                                               */
/* -------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x11151a, 0.0095);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.rotateSpeed = 0.78;
controls.panSpeed = 0.7;
controls.zoomSpeed = 0.82;
controls.minDistance = 5;
controls.maxDistance = 46;
controls.minPolarAngle = 0.08;
controls.maxPolarAngle = Math.PI * 0.93;
controls.target.set(2, 0, 0);

/* Studio environment. */
const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environmentTexture = pmrem.fromScene(room, 0.03).texture;
scene.environment = environmentTexture;
scene.environmentIntensity = 0.38;
room.dispose?.();
pmrem.dispose();

/* A restrained three-point setup keeps the jade material readable on dark. */
const hemi = new THREE.HemisphereLight(0xc8e2ff, 0x1b1512, 0.52);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xfff2df, 1.95);
keyLight.position.set(6.5, 8.5, 7);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x6edcd6, 0.82);
fillLight.position.set(-7, 3.8, -5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xff7c38, 1.65);
rimLight.position.set(1.5, -4.5, -6);
scene.add(rimLight);

const topLight = new THREE.DirectionalLight(0xffffff, 0.28);
topLight.position.set(0, 12, 0);
scene.add(topLight);

/* -------------------------------------------------------------------------- */
/* Floor grid, contact shadow, and axis                                       */
/* -------------------------------------------------------------------------- */

const floorGroup = new THREE.Group();
scene.add(floorGroup);

function makeGridMaterial(plane, opacity) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
    uniforms: {
      uFadeCenter: { value: new THREE.Vector2(2, 0) },
      uPlane: { value: plane },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uFadeCenter;
      uniform float uOpacity;
      uniform int uPlane;
      varying vec3 vWorld;

      float gridMask(vec2 p, float scale) {
        vec2 c = p / scale;
        vec2 grid = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(0.00001));
        float line = min(grid.x, grid.y);
        return 1.0 - smoothstep(0.0, 1.15, line);
      }

      void main() {
        vec2 p;
        if (uPlane == 0) {
          p = vWorld.xz;
        } else if (uPlane == 1) {
          p = vWorld.xy;
        } else {
          p = vWorld.zy;
        }

        float minor = gridMask(p, 1.0);
        float major = gridMask(p, 5.0);
        float distanceFade = 1.0 - smoothstep(11.0, 31.0, length(p - uFadeCenter));

        vec3 minorColor = vec3(0.205, 0.238, 0.274);
        vec3 majorColor = vec3(0.325, 0.365, 0.414);
        vec3 color = mix(minorColor, majorColor, major);
        float alpha = (minor * 0.28 + major * 0.38) * distanceFade * uOpacity;

        if (alpha < 0.004) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

const gridMaterial = makeGridMaterial(0, 1.0);
const grid = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), gridMaterial);
grid.rotation.x = -Math.PI / 2;
grid.renderOrder = -3;
floorGroup.add(grid);

const backGridMaterial = makeGridMaterial(1, 0.62);
const backGrid = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), backGridMaterial);
backGrid.renderOrder = -3;
floorGroup.add(backGrid);

const sideGridMaterial = makeGridMaterial(2, 0.52);
const sideGrid = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), sideGridMaterial);
sideGrid.rotation.y = Math.PI / 2;
sideGrid.renderOrder = -3;
floorGroup.add(sideGrid);

function makeShadowTexture() {
  const size = 128;
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = size;
  shadowCanvas.height = size;
  const ctx = shadowCanvas.getContext("2d");
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * 0.02,
    size / 2,
    size / 2,
    size * 0.5,
  );
  gradient.addColorStop(0, "rgba(0, 0, 0, 0.64)");
  gradient.addColorStop(0.38, "rgba(0, 0, 0, 0.4)");
  gradient.addColorStop(0.72, "rgba(0, 0, 0, 0.12)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(shadowCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const shadowMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    map: makeShadowTexture(),
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    toneMapped: false,
  }),
);
shadowMesh.rotation.x = -Math.PI / 2;
shadowMesh.renderOrder = -2;
floorGroup.add(shadowMesh);

const axisVisual = new THREE.Group();
scene.add(axisVisual);

const axisMaterial = new THREE.LineDashedMaterial({
  color: 0xff9950,
  dashSize: 0.12,
  gapSize: 0.1,
  transparent: true,
  opacity: 0.62,
  depthTest: false,
  depthWrite: false,
});
const axisGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-0.78, 0, 0),
  new THREE.Vector3(4.78, 0, 0),
]);
const axisLine = new THREE.Line(axisGeometry, axisMaterial);
axisLine.computeLineDistances();
axisLine.renderOrder = 20;
axisVisual.add(axisLine);

const axisTipMaterial = new THREE.MeshBasicMaterial({
  color: 0xffa361,
  transparent: true,
  opacity: 0.8,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const axisTipGeometry = new THREE.ConeGeometry(0.052, 0.2, 14);
const leftTip = new THREE.Mesh(axisTipGeometry, axisTipMaterial);
leftTip.position.x = -0.79;
leftTip.rotation.z = Math.PI / 2;
leftTip.renderOrder = 21;
axisVisual.add(leftTip);
const rightTip = new THREE.Mesh(axisTipGeometry, axisTipMaterial);
rightTip.position.x = 4.79;
rightTip.rotation.z = -Math.PI / 2;
rightTip.renderOrder = 21;
axisVisual.add(rightTip);

/* -------------------------------------------------------------------------- */
/* Coordinate axes                                                            */
/* -------------------------------------------------------------------------- */

const coordinateAxesGroup = new THREE.Group();
scene.add(coordinateAxesGroup);

const coordinatePalette = {
  x: 0xe77a6c,
  y: 0x74d49f,
  z: 0x6f9df1,
};

function makeCoordinateLine(color) {
  return new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.48,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
}

function makeCoordinateArrow(color) {
  return new THREE.Mesh(
    new THREE.ConeGeometry(0.055, 0.2, 12),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.66,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
}

function makeCoordinateBadge(letter, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(28, 28, 72, 72, 12);
  } else {
    ctx.rect(28, 28, 72, 72);
  }
  ctx.fillStyle = "rgba(12, 15, 19, 0.8)";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '600 52px "MesloLGS Nerd Font", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, 64, 68);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sprite.scale.set(0.62, 0.62, 1);
  sprite.renderOrder = 32;
  return sprite;
}

const coordXLine = makeCoordinateLine(coordinatePalette.x);
const coordYLine = makeCoordinateLine(coordinatePalette.y);
const coordZLine = makeCoordinateLine(coordinatePalette.z);
const coordXArrow = makeCoordinateArrow(coordinatePalette.x);
const coordYArrow = makeCoordinateArrow(coordinatePalette.y);
const coordZArrow = makeCoordinateArrow(coordinatePalette.z);
coordXArrow.rotation.z = -Math.PI / 2;
coordZArrow.rotation.x = Math.PI / 2;
const coordXBadge = makeCoordinateBadge("x", "#ef8a7e");
const coordYBadge = makeCoordinateBadge("y", "#86e1ae");
const coordZBadge = makeCoordinateBadge("z", "#88b0fb");
coordinateAxesGroup.add(
  coordXLine,
  coordYLine,
  coordZLine,
  coordXArrow,
  coordYArrow,
  coordZArrow,
  coordXBadge,
  coordYBadge,
  coordZBadge,
);

function makeCoordinateTicks(color) {
  return new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.38,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
}

const coordXTicks = makeCoordinateTicks(coordinatePalette.x);
const coordYTicks = makeCoordinateTicks(coordinatePalette.y);
const coordZTicks = makeCoordinateTicks(coordinatePalette.z);
coordinateAxesGroup.add(coordXTicks, coordYTicks, coordZTicks);

function setCoordinateLine(line, points) {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

function setTickGeometry(lines, points) {
  lines.geometry.dispose();
  lines.geometry = new THREE.BufferGeometry().setFromPoints(points);
}

function tickStepFor(start, end) {
  const span = end - start;
  if (span > 24) return 5;
  if (span > 12) return 2;
  return 1;
}

function updateCoordinateTicks(anchorX, xStart, xEnd, yStart, yEnd, zStart, zEnd) {
  const span = Math.max(xEnd - xStart, yEnd - yStart, zEnd - zStart);
  const baseTick = clamp(span * 0.012, 0.045, 0.11);

  const xPoints = [];
  const xStep = tickStepFor(xStart, xEnd);
  for (let x = Math.ceil(xStart / xStep) * xStep; x <= xEnd + 1e-6; x += xStep) {
    const length = Math.abs(x / 5 - Math.round(x / 5)) < 1e-6 ? baseTick * 1.9 : baseTick;
    xPoints.push(
      new THREE.Vector3(x, 0, -length),
      new THREE.Vector3(x, 0, length),
    );
  }
  setTickGeometry(coordXTicks, xPoints);

  const yPoints = [];
  const yStep = tickStepFor(yStart, yEnd);
  for (let y = Math.ceil(yStart / yStep) * yStep; y <= yEnd + 1e-6; y += yStep) {
    const length = Math.abs(y / 5 - Math.round(y / 5)) < 1e-6 ? baseTick * 1.9 : baseTick;
    yPoints.push(
      new THREE.Vector3(anchorX - length, y, 0),
      new THREE.Vector3(anchorX + length, y, 0),
    );
  }
  setTickGeometry(coordYTicks, yPoints);

  const zPoints = [];
  const zStep = tickStepFor(zStart, zEnd);
  for (let z = Math.ceil(zStart / zStep) * zStep; z <= zEnd + 1e-6; z += zStep) {
    const length = Math.abs(z / 5 - Math.round(z / 5)) < 1e-6 ? baseTick * 1.9 : baseTick;
    zPoints.push(
      new THREE.Vector3(anchorX - length, 0, z),
      new THREE.Vector3(anchorX + length, 0, z),
    );
  }
  setTickGeometry(coordZTicks, zPoints);
}

function updateCoordinateAxes(problem) {
  const x0 = problem.domain?.x0 ?? 0;
  const x1 = problem.domain?.x1 ?? 4;
  const xLow = Math.min(x0, x1);
  const xHigh = Math.max(x0, x1);
  const maxRadius = Math.max(problem.maxRadius, 0.5);
  const anchorX = clamp(0, xLow, xHigh);
  const xStart = xLow - 0.45;
  const xEnd = xHigh + 0.55;
  const yStart = Math.min(0, problem.axisValue - maxRadius) - 0.45;
  const yEnd = Math.max(0, problem.axisValue + maxRadius) + 0.5;
  const zStart = -maxRadius - 0.35;
  const zEnd = maxRadius + 0.55;

  setCoordinateLine(coordXLine, [
    new THREE.Vector3(xStart, 0, 0),
    new THREE.Vector3(xEnd, 0, 0),
  ]);
  setCoordinateLine(coordYLine, [
    new THREE.Vector3(anchorX, yStart, 0),
    new THREE.Vector3(anchorX, yEnd, 0),
  ]);
  setCoordinateLine(coordZLine, [
    new THREE.Vector3(anchorX, 0, zStart),
    new THREE.Vector3(anchorX, 0, zEnd),
  ]);

  updateCoordinateTicks(
    anchorX,
    xStart,
    xEnd,
    yStart,
    yEnd,
    zStart,
    zEnd,
  );

  const arrowScale = clamp(Math.max(xHigh - xLow, maxRadius) * 0.045, 0.65, 1.8);
  for (const arrow of [coordXArrow, coordYArrow, coordZArrow]) {
    arrow.scale.setScalar(arrowScale);
  }
  coordXArrow.position.set(xEnd, 0, 0);
  coordYArrow.position.set(anchorX, yEnd, 0);
  coordZArrow.position.set(anchorX, 0, zEnd);

  const badgeScale = clamp(Math.max(xHigh - xLow, maxRadius) * 0.075, 0.5, 1.0);
  coordXBadge.position.set(xEnd + 0.18, 0.28, 0);
  coordYBadge.position.set(anchorX + 0.26, yEnd - 0.02, 0);
  coordZBadge.position.set(anchorX + 0.26, 0.28, zEnd);
  for (const badge of [coordXBadge, coordYBadge, coordZBadge]) {
    badge.scale.set(badgeScale, badgeScale, 1);
  }
}

function updateAxisVisual(axisValue, x0, x1) {
  const points = [
    new THREE.Vector3(x0 - 0.78, 0, 0),
    new THREE.Vector3(x1 + 0.78, 0, 0),
  ];
  axisLine.geometry.dispose();
  axisLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
  axisLine.computeLineDistances();
  leftTip.position.x = x0 - 0.79;
  rightTip.position.x = x1 + 0.79;
  axisVisual.position.y = axisValue;
}

function placeStudio(problem) {
  const { x0 = 0, x1 = 4 } = problem.domain || {};
  const xLow = Math.min(x0, x1);
  const xHigh = Math.max(x0, x1);
  const xMid = (xLow + xHigh) / 2;
  const span = Math.max(xHigh - xLow, 0.5);
  const floorY = problem.axisValue - problem.maxRadius - 1.28;
  const ceilingY = problem.axisValue + problem.maxRadius + 1.1;
  const wallCenterY = (floorY + ceilingY) / 2;
  const backWallZ = -problem.maxRadius - 1.35;
  const sideWallX = xLow - 1.05;

  grid.position.set(0, floorY, 0);
  gridMaterial.uniforms.uFadeCenter.value.set(xMid, 0);

  backGrid.position.set(xMid, wallCenterY, backWallZ);
  backGridMaterial.uniforms.uFadeCenter.value.set(xMid, wallCenterY);

  sideGrid.position.set(sideWallX, wallCenterY, 0);
  sideGridMaterial.uniforms.uFadeCenter.value.set(0, wallCenterY);

  const shadowWidth = span * 1.3 + problem.maxRadius * 1.35 + 1.2;
  const shadowDepth = problem.maxRadius * 2.35 + 1.2;
  shadowMesh.position.set(xMid, floorY + 0.012, 0);
  shadowMesh.scale.set(shadowWidth, shadowDepth, 1);

  updateAxisVisual(problem.axisValue, x0, x1);
  updateCoordinateAxes(problem);
}

/* -------------------------------------------------------------------------- */
/* Case UI and selection                                                      */
/* -------------------------------------------------------------------------- */

function paddingForMethod(method) {
  return method.toUpperCase();
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

function niceStep(range, target = 5) {
  const rough = Math.max(range / target, 1e-9);
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const fraction = rough / power;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

function formatTick(value, step) {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return formatNumber(value, decimals).replace("-", "−");
}

function renderRegionGraph(variant) {
  const svg = $("#regionGraph");
  if (!svg || !variant) return;
  svg.replaceChildren();

  const { x0 = 0, x1 = 4 } = variant.domain || {};
  const axis = variant.axisValue;
  const regionAboveAxis = Math.abs(variant.startAngle) < 0.01;
  const lowerAt = regionAboveAxis
    ? (x) => axis + variant.inner(x)
    : (x) => axis - variant.outer(x);
  const upperAt = regionAboveAxis
    ? (x) => axis + variant.outer(x)
    : (x) => axis - variant.inner(x);

  const sampleCount = 110;
  const samples = [];
  for (let i = 0; i <= sampleCount; i++) {
    const x = x0 + ((x1 - x0) * i) / sampleCount;
    samples.push({
      x,
      lower: lowerAt(x),
      upper: upperAt(x),
    });
  }

  const xRangeBase = Math.abs(x1 - x0) || 1;
  const minY = Math.min(axis, ...samples.map((point) => point.lower));
  const maxY = Math.max(axis, ...samples.map((point) => point.upper));
  const yRangeBase = Math.max(maxY - minY, 0.5);

  const xPadding = xRangeBase * 0.055 + 0.08;
  const yPadding = yRangeBase * 0.12 + 0.12;
  const view = {
    xMin: Math.min(x0, x1) - xPadding,
    xMax: Math.max(x0, x1) + xPadding,
    yMin: minY - yPadding,
    yMax: maxY + yPadding,
  };

  const width = 280;
  const height = 150;
  const margin = { left: 25, right: 10, top: 9, bottom: 19 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const mapX = (x) =>
    margin.left + ((x - view.xMin) / (view.xMax - view.xMin)) * plotWidth;
  const mapY = (y) =>
    margin.top + ((view.yMax - y) / (view.yMax - view.yMin)) * plotHeight;

  const xStep = niceStep(view.xMax - view.xMin, 5);
  const yStep = niceStep(view.yMax - view.yMin, 3.5);
  const gridGroup = svgElement("g");

  for (
    let value = Math.ceil(view.xMin / xStep) * xStep;
    value <= view.xMax + xStep * 0.001;
    value += xStep
  ) {
    const x = mapX(value);
    gridGroup.append(
      svgElement("line", {
        x1: x,
        y1: margin.top,
        x2: x,
        y2: margin.top + plotHeight,
        class: Math.abs(value) < xStep * 0.001 ? "graph-axis" : "graph-gridline",
      }),
    );
    if (Math.abs(value) > xStep * 0.001) {
      const label = svgElement("text", {
        x,
        y: height - 6,
        class: "graph-tick",
        "text-anchor": "middle",
      });
      label.textContent = formatTick(value, xStep);
      gridGroup.append(label);
    }
  }

  for (
    let value = Math.ceil(view.yMin / yStep) * yStep;
    value <= view.yMax + yStep * 0.001;
    value += yStep
  ) {
    const y = mapY(value);
    gridGroup.append(
      svgElement("line", {
        x1: margin.left,
        y1: y,
        x2: margin.left + plotWidth,
        y2: y,
        class: Math.abs(value) < yStep * 0.001 ? "graph-axis" : "graph-gridline",
      }),
    );
    if (Math.abs(value) > yStep * 0.001) {
      const label = svgElement("text", {
        x: margin.left - 4,
        y: y + 2,
        class: "graph-tick",
        "text-anchor": "end",
      });
      label.textContent = formatTick(value, yStep);
      gridGroup.append(label);
    }
  }
  svg.append(gridGroup);

  const regionPoints = [
    ...samples.map((point) => `${mapX(point.x)},${mapY(point.upper)}`),
    ...samples
      .slice()
      .reverse()
      .map((point) => `${mapX(point.x)},${mapY(point.lower)}`),
  ];
  svg.append(
    svgElement("path", {
      d: `M ${regionPoints.join(" L ")} Z`,
      class: "graph-region",
    }),
  );

  const upperPath = samples
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${mapX(point.x)} ${mapY(point.upper)}`,
    )
    .join(" ");
  const lowerPath = samples
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"} ${mapX(point.x)} ${mapY(point.lower)}`,
    )
    .join(" ");

  svg.append(
    svgElement("path", { d: upperPath, class: "graph-upper" }),
    svgElement("path", { d: lowerPath, class: "graph-lower" }),
  );

  const axisY = mapY(axis);
  svg.append(
    svgElement("line", {
      x1: margin.left,
      y1: axisY,
      x2: margin.left + plotWidth,
      y2: axisY,
      class: "graph-rotation",
    }),
  );

  const upperLabel = svgElement("text", {
    x: margin.left + plotWidth - 2,
    y: Math.max(margin.top + 7, mapY(samples.at(-1).upper) - 4),
    class: "graph-label upper",
    "text-anchor": "end",
  });
  upperLabel.textContent = "f";
  svg.append(upperLabel);

  const lowerLabel = svgElement("text", {
    x: margin.left + plotWidth - 2,
    y: Math.min(
      margin.top + plotHeight - 2,
      mapY(samples.at(-1).lower) + 8,
    ),
    class: "graph-label lower",
    "text-anchor": "end",
  });
  lowerLabel.textContent = "g";
  svg.append(lowerLabel);

  const axisLabel = svgElement("text", {
    x: margin.left + plotWidth - 2,
    y: Math.max(margin.top + 7, Math.min(axisY - 4, margin.top + plotHeight - 2)),
    class: "graph-label rotation",
    "text-anchor": "end",
  });
  axisLabel.textContent = `y = ${formatNumber(axis)}`;
  svg.append(axisLabel);

  $("#graphScale").textContent = `x: ${formatNumber(x0)}…${formatNumber(x1)}`;
}

function updateCaseUI(problem) {
  const custom = currentProblem.id === "custom";
  $("#caseCrumb").textContent = custom
    ? "CUSTOM STUDY"
    : `STUDY ${problem.letter}`;
  $("#objectName").textContent =
    currentProblem.id === "custom"
      ? `${currentProblem.title} · ${problem.title}`
      : problem.title;
  $("#objectMethod").textContent = `${problem.method} · ${problem.subtitle}`;
  $("#sceneEquation").textContent = currentProblem.region.equation;
  $("#topbarScene").textContent = custom
    ? `Custom · ${problem.methodShort.toLowerCase()}`
    : `Study ${problem.letter} · ${problem.methodShort.toLowerCase()}`;
  $("#axisChipLabel").textContent = problem.axisFormula;

  $("#methodBadge").textContent = paddingForMethod(problem.method);
  $("#methodMini").textContent = problem.methodShort;
  $("#volumeCard").classList.toggle("is-numeric", !problem.fraction);
  $("#volumeEyebrow").textContent = problem.fraction
    ? "EXACT VOLUME"
    : "NUMERICAL VOLUME";
  if (problem.fraction) {
    $("#volumeNumerator").textContent = problem.fraction[0];
    $("#volumeDenominator").textContent = problem.fraction[1];
  }
  $("#volumeDecimal").textContent = problem.volume.toFixed(3);
  $("#volumeCaption").textContent = problem.caption;
  $("#radiusSummary").textContent = problem.radiusSummary;
  $("#integralText").textContent = problem.integral;
  $("#expansionText").textContent = problem.expansion || "";
  $("#expansionText").classList.toggle("is-hidden", !problem.expansion);
  $("#resultText").textContent = problem.result;
  $("#caseNote").textContent = problem.note;
  $("#approxFormula").textContent = problem.approximationFormula;

  $$(".case-button").forEach((button) => {
    const selected = button.dataset.case === problem.id;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  document.title = `Revolve Lab — ${problem.title}`;
  renderRegionGraph(problem);
  updateApproxUI();
  updateStatusMessage();
}

function makeCaseButton(variant) {
  const button = document.createElement("button");
  button.className = "case-button";
  button.dataset.case = variant.id;
  button.setAttribute("aria-pressed", "false");

  const letter = document.createElement("span");
  letter.className = "case-letter";
  letter.textContent = variant.letter || "A";

  const copy = document.createElement("span");
  copy.className = "case-copy";
  const strong = document.createElement("strong");
  strong.textContent = variant.title;
  const small = document.createElement("small");
  small.textContent = `${variant.axisFormula} · ${variant.method.toLowerCase()}`;
  copy.append(strong, small);

  const value = document.createElement("span");
  value.className = "case-value";
  value.textContent = variant.volume.toFixed(2);

  const chevron = document.createElement("span");
  chevron.className = "case-chevron";
  chevron.textContent = "›";

  button.append(letter, copy, value, chevron);
  return button;
}

function renderCaseList() {
  const list = $("#caseList");
  list.replaceChildren(...currentProblem.variants.map(makeCaseButton));
}

function renderProblemMenu() {
  const list = $("#problemMenuList");
  list.replaceChildren();
  for (const problem of problemRegistry.values()) {
    const button = document.createElement("button");
    button.dataset.loadProblem = problem.id;
    const label = document.createElement("span");
    label.textContent = problem.title;
    const detail = document.createElement("kbd");
    detail.textContent =
      problem.id === currentProblem.id ? "CURRENT" : `${problem.variants.length}×`;
    button.append(label, detail);
    if (problem.id === currentProblem.id) {
      button.classList.add("is-current");
    }
    list.append(button);
  }
}

function updateProblemChrome() {
  $("#brandProject").textContent =
    currentProblem.id === "custom" ? currentProblem.title : "Parabolic cap";
  $("#regionEquation").textContent = currentProblem.region.equation;
  $("#regionDomain").textContent = currentProblem.region.domainLabel;
  $("#buildProblemBtn").classList.toggle(
    "is-custom-active",
    currentProblem.id === "custom",
  );
  updateAboutModal();
}

function updateAboutModal() {
  $("#aboutTitle").innerHTML = currentProblem.aboutTitle;
  $("#aboutText").textContent = currentProblem.region.description;
  const volumes = $("#aboutVolumes");
  volumes.replaceChildren();
  volumes.style.gridTemplateColumns = `repeat(${Math.min(
    3,
    currentProblem.variants.length,
  )}, 1fr)`;
  for (const variant of currentProblem.variants) {
    const item = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = `${variant.letter} · ${variant.axisFormula}`;
    const value = document.createElement("strong");
    value.textContent = variant.fraction
      ? variant.fraction.join(" / ")
      : `≈ ${variant.volume.toFixed(3)}`;
    const small = document.createElement("small");
    small.textContent = variant.fraction
      ? `≈ ${variant.volume.toFixed(3)}`
      : variant.methodShort.toLowerCase();
    item.append(label, value, small);
    volumes.append(item);
  }
}

function disposeCurrentSolids() {
  for (const solid of Object.values(solidSets)) {
    scene.remove(solid.group);
    disposeObject(solid.group);
  }
  solidSets = {};
}

function loadProblem(problem, options = {}) {
  const { variantId, animateCamera = true, announce = false } = options;
  stopIntro();
  setPlaying(false);
  if (state.approx) setApproxEnabled(false, { silent: true });

  disposeCurrentSolids();
  currentProblem = problem;
  currentProblemVariants = new Map(
    problem.variants.map((variant) => [variant.id, variant]),
  );
  state.activeCaseId = null;
  activeCase = null;
  activeSolid = null;

  for (const variant of problem.variants) {
    const solid = createRevolvedSolid(variant);
    solid.group.visible = false;
    solidSets[variant.id] = solid;
    scene.add(solid.group);
  }

  updateProblemChrome();
  renderCaseList();
  renderProblemMenu();
  selectCase(variantId || problem.variants[0].id, {
    animateCamera,
    announce,
    force: true,
  });
}

function selectCase(id, options = {}) {
  const problem = currentProblemVariants.get(id);
  if (!problem) return;
  const { animateCamera = true, announce = true, force = false } = options;
  if (state.activeCaseId === id && !force) {
    updateCaseUI(problem);
    frameCase(id, animateCamera);
    return;
  }

  if (introAnimation) introAnimation = null;
  if (state.approx) setApproxEnabled(false, { silent: true });
  const previousId = state.activeCaseId;
  state.activeCaseId = id;
  activeCase = problem;

  if (previousId && solidSets[previousId]) {
    solidSets[previousId].group.visible = false;
  }

  activeSolid = solidSets[id];
  activeSolid.group.visible = true;
  activeSolid.applyMode(state.mode);
  activeSolid.updateSweep(state.angle * DEG);

  placeStudio(problem);
  updateCaseUI(problem);
  setShadingButtonState(state.mode);
  updateProblemChrome();

  $("#caseCrumb").classList.add("switching");
  window.setTimeout(() => $("#caseCrumb").classList.remove("switching"), 420);

  frameCase(id, animateCamera);
  updateSceneReadout();
  if (announce) {
    const where =
      currentProblem.id === "custom"
        ? problem.axisFormula
        : `Study ${problem.letter} · ${problem.axisFormula}`;
    showToast(currentProblem.id === "custom" ? `Custom solid · ${where}` : where);
  }
}

function frameCase(id = state.activeCaseId, animate = true) {
  if (!id) return;
  const problem = currentProblemVariants.get(id);
  if (!problem) return;
  const { x0 = 0, x1 = 4 } = problem.domain || {};
  const xMid = (x0 + x1) / 2;
  const span = x1 - x0;
  const aspect = Math.max(viewport.clientWidth / viewport.clientHeight, 0.4);
  const vFov = camera.fov * DEG;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fitFov = Math.min(vFov, hFov);
  const sphereRadius =
    Math.hypot(span * 0.59 + 0.35, problem.maxRadius) * 1.035;
  const fitScale = aspect < 0.8 ? 0.8 : 1.08;
  const distance = (sphereRadius / Math.sin(fitFov / 2)) * fitScale;
  const target = new THREE.Vector3(xMid, problem.axisValue, 0);
  const direction = new THREE.Vector3(0.62, 0.41, 1.05).normalize();
  const position = target.clone().addScaledVector(direction, distance);

  if (animate && !reducedMotion) {
    cameraTween = {
      start: performance.now(),
      duration: 760,
      fromPosition: camera.position.clone(),
      toPosition: position,
      fromTarget: controls.target.clone(),
      toTarget: target,
    };
  } else {
    cameraTween = null;
    camera.position.copy(position);
    controls.target.copy(target);
    camera.lookAt(target);
    controls.update();
  }
}

function updateSceneReadout() {
  if (!activeCase) return;
  const modeLabel =
    state.mode === "xray" ? "x-ray" : state.mode === "wire" ? "wire" : "solid";
  const studyLabel =
    currentProblem.id === "custom"
      ? "Custom"
      : `Study ${activeCase.letter}`;
  $("#topbarScene").textContent = state.approx
    ? `${studyLabel} · washers`
    : `${studyLabel} · ${modeLabel}`;
  $("#statusMessage").textContent = state.approx
    ? `Riemann washer stack · n = ${state.slices} · ${state.angle.toFixed(0)}°`
    : state.angle >= 359.5
      ? `Full solid · ${activeCase.method.toLowerCase()} · 360°`
      : state.angle <= 0.5
        ? "Profile view · the generating region"
        : `Revolving region · ${state.angle.toFixed(0)}°`;
  $("#triangleCount").textContent = `${numberFormat.format(countTriangles())} tris`;
}

function countTriangles() {
  let total = 0;
  if (activeSolid) {
    activeSolid.group.traverse((object) => {
      if (!object.isMesh) return;
      let parent = object;
      while (parent) {
        if (!parent.visible) return;
        parent = parent.parent;
      }
      const geometry = object.geometry;
      if (!geometry) return;
      let count = geometry.index
        ? geometry.index.count
        : geometry.attributes.position?.count || 0;
      const drawRange = geometry.drawRange;
      if (drawRange && drawRange.count !== Infinity) {
        count = Math.min(count, drawRange.count);
      }
      total += Math.max(0, Math.floor(count / 3));
    });
  }
  if (washerGroup) {
    washerGroup.traverse((object) => {
      if (!object.isMesh && !object.isLineSegments) return;
      const geometry = object.geometry;
      if (!geometry) return;
      const count = geometry.index
        ? geometry.index.count
        : geometry.attributes.position?.count || 0;
      total += Math.max(0, Math.floor(count / 3));
    });
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/* Angle / revolve state                                                      */
/* -------------------------------------------------------------------------- */

function setAngle(degrees, options = {}) {
  const { animateUI = true } = options;
  const next = clamp(degrees, 0, 360);

  if (state.approx && next < 359.5) {
    setApproxEnabled(false, { silent: true });
    showToast("Washers hidden · a full revolution is required");
  }

  state.angle = next;
  if (activeSolid) activeSolid.updateSweep(next * DEG);

  if (animateUI) {
    $("#angleReadout").textContent = next.toFixed(0);
    $("#angleRange").value = next.toFixed(1);
    $("#angleRange").style.setProperty("--angle-pct", `${(next / 360) * 100}%`);
    $$("[data-angle]").forEach((button) => {
      button.classList.toggle(
        "active",
        Math.abs(Number(button.dataset.angle) - next) < 0.6,
      );
    });
    updateStatusMessage();
    updateSceneReadout();
  }
}

function updateStatusMessage() {
  if (!activeCase) return;
  if (state.approx) {
    $("#statusMessage").textContent = `Riemann washer stack · n = ${state.slices}`;
  } else if (state.angle >= 359.5) {
    $("#statusMessage").textContent = `Full solid · ${activeCase.method.toLowerCase()} · 360°`;
  } else if (state.angle <= 0.5) {
    $("#statusMessage").textContent = "Profile view · the generating region";
  } else {
    $("#statusMessage").textContent = `Revolving region · ${state.angle.toFixed(0)}°`;
  }
}

function setPlaying(playing) {
  if (playing) {
    if (introAnimation) introAnimation = null;
    if (state.approx) {
      setApproxEnabled(false, { silent: true });
      showToast("Washers hidden · playing the revolve");
    }
    if (state.angle >= 359.5) setAngle(0);
  }
  state.playing = playing;
  $("#timelineDock").classList.toggle("playing", playing);
  $("#playBtn").setAttribute(
    "aria-label",
    playing ? "Pause revolve" : "Play revolve",
  );
}

function stopIntro() {
  if (introAnimation) introAnimation = null;
}

/* -------------------------------------------------------------------------- */
/* Approximation                                                              */
/* -------------------------------------------------------------------------- */

function updateApproxUI() {
  if (!activeCase) return;
  const n = state.slices;
  const estimate = approximateVolume(activeCase, n);
  const delta = estimate - activeCase.volume;
  const percent = Math.abs((delta / activeCase.volume) * 100);
  const direction = delta < 0 ? "below" : "above";

  $("#nValue").textContent = String(n);
  $("#nValue").style.fontVariantNumeric = "tabular-nums";
  $("#approxValue").textContent = `${estimate.toFixed(2)} u³`;
  $("#errorText").textContent = `${percent < 0.001 ? percent.toFixed(4) : percent.toFixed(3)}% ${direction} exact`;
  $("#errorFill").style.width = `${clamp(Math.sqrt(percent / 5) * 100, 2, 100)}%`;
  $("#nRange").style.setProperty(
    "--n-pct",
    `${((n - Number($("#nRange").min)) /
      (Number($("#nRange").max) - Number($("#nRange").min))) *
      100}%`,
  );
  $("#approxNote").textContent = state.approx
    ? "Midpoint sample shown at 360°. Drag the timeline to return to the solid."
    : "Enable to inspect the washer stack. The study snaps to a full revolution.";
  $("#approxBody").classList.toggle("is-active", state.approx);
  $("#approxToggle").checked = state.approx;
}

function disposeObject(root) {
  if (!root) return;
  const materials = new Set();
  root.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => materials.add(material));
    } else if (object.material) {
      materials.add(object.material);
    }
  });
  materials.forEach((material) => material.dispose());
}

function removeWashers() {
  window.clearTimeout(washerTimer);
  if (washerGroup) {
    scene.remove(washerGroup);
    disposeObject(washerGroup);
    washerGroup = null;
  }
}

function buildWashers() {
  if (!activeCase) return;
  removeWashers();
  washerGroup = createWashers(activeCase, state.slices);
  washerGroup.visible = true;
  scene.add(washerGroup);
  $("#triangleCount").textContent = `${numberFormat.format(countTriangles())} tris`;
}

function setApproxEnabled(enabled, options = {}) {
  const { silent = false } = options;
  if (enabled === state.approx) {
    updateApproxUI();
    return;
  }

  if (enabled) {
    setPlaying(false);
    if (introAnimation) introAnimation = null;
    if (state.angle < 359.5) setAngle(360, { animateUI: true });
    state.approx = true;
    activeSolid.applyMode("ghost");
    buildWashers();
    if (!silent) showToast(`Washer approximation · n = ${state.slices}`);
  } else {
    state.approx = false;
    removeWashers();
    if (activeSolid) activeSolid.applyMode(state.mode);
    if (!silent) showToast("Returned to the solid");
  }

  updateApproxUI();
  updateSceneReadout();
  $("#washerQuickBtn").classList.toggle("active", state.approx);
}

/* -------------------------------------------------------------------------- */
/* Display modes, tools, grid, and UI                                         */
/* -------------------------------------------------------------------------- */

function setShading(mode, options = {}) {
  const { silent = false } = options;
  if (!["solid", "xray", "wire"].includes(mode)) return;
  if (state.approx) setApproxEnabled(false, { silent: true });
  state.mode = mode;
  if (activeSolid) activeSolid.applyMode(mode);
  setShadingButtonState(mode);
  updateSceneReadout();

  if (!silent) {
    const label =
      mode === "xray" ? "X-ray shading" : mode === "wire" ? "Wireframe" : "Material preview";
    showToast(label);
  }
}

function setShadingButtonState(mode) {
  $$(".shading-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.shading === mode);
  });
  $("#railWire").classList.toggle("active", mode === "wire");
}

function setTool(tool) {
  state.tool = tool;
  const mapping = {
    orbit: THREE.MOUSE.ROTATE,
    pan: THREE.MOUSE.PAN,
    zoom: THREE.MOUSE.DOLLY,
  };
  controls.mouseButtons.LEFT = mapping[tool] || THREE.MOUSE.ROTATE;
  $$(".rail-button[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
  viewport.classList.toggle("tool-pan", tool === "pan");
  viewport.classList.toggle("tool-zoom", tool === "zoom");
}

function toggleGrid(force) {
  state.grid = typeof force === "boolean" ? force : !state.grid;
  floorGroup.visible = state.grid;
  $("#railGrid").classList.toggle("active", state.grid);
  showToast(state.grid ? "Grid and floor shown" : "Grid and floor hidden");
}

function togglePlay() {
  if (state.playing) {
    setPlaying(false);
  } else {
    setPlaying(true);
  }
}

function showToast(message, duration = 1900) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), duration);
}

function resetStudy() {
  stopIntro();
  setPlaying(false);
  setApproxEnabled(false, { silent: true });
  setShading("solid", { silent: true });
  state.slices = 24;
  $("#nRange").value = "24";
  if (!state.grid) toggleGrid(true);
  loadProblem(PRESET_PROBLEM, {
    variantId: "a",
    animateCamera: true,
  });
  setAngle(360);
  setTool("orbit");
  updateApproxUI();
  showToast("Study reset");
}

/* -------------------------------------------------------------------------- */
/* Washer count                                                               */
/* -------------------------------------------------------------------------- */

$("#nRange").addEventListener("input", (event) => {
  state.slices = Number(event.target.value);
  updateApproxUI();
  updateSceneReadout();
  if (state.approx) {
    window.clearTimeout(washerTimer);
    washerTimer = window.setTimeout(() => {
      if (state.approx) buildWashers();
    }, 70);
  }
});

$("#approxToggle").addEventListener("change", (event) => {
  setApproxEnabled(event.target.checked);
});

/* -------------------------------------------------------------------------- */
/* Timeline controls                                                          */
/* -------------------------------------------------------------------------- */

$("#playBtn").addEventListener("click", () => {
  stopIntro();
  togglePlay();
});

$("#toStartBtn").addEventListener("click", () => {
  stopIntro();
  setPlaying(false);
  setAngle(0);
});

$("#toEndBtn").addEventListener("click", () => {
  stopIntro();
  setPlaying(false);
  setAngle(360);
});

$("#angleRange").addEventListener("pointerdown", () => {
  stopIntro();
  setPlaying(false);
});

$("#angleRange").addEventListener("input", (event) => {
  setAngle(Number(event.target.value));
});

$$("[data-angle]").forEach((button) => {
  button.addEventListener("click", () => {
    const angle = Number(button.dataset.angle);
    stopIntro();
    setPlaying(false);
    setAngle(angle);
    if (Number.isFinite(angle)) {
      showToast(
        angle === 0
          ? "Source region"
          : angle === 360
            ? "Full revolution · 360°"
            : `${angle}° cutaway`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Case selection and shading                                                */
/* -------------------------------------------------------------------------- */

$("#caseList").addEventListener("click", (event) => {
  const button = event.target.closest(".case-button[data-case]");
  if (!button) return;
  selectCase(button.dataset.case);
  closeMenus();
  if (window.innerWidth <= 900) {
    $("#propertiesPanel").classList.remove("open");
  }
});

$("#problemMenuList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-load-problem]");
  if (!button) return;
  const problem = problemRegistry.get(button.dataset.loadProblem);
  if (!problem) return;
  loadProblem(problem, { animateCamera: true });
  closeMenus();
});

$("#buildProblemBtn").addEventListener("click", () => openBuilder());

$$(".shading-button").forEach((button) => {
  button.addEventListener("click", () => {
    stopIntro();
    setShading(button.dataset.shading);
  });
});

$$(".rail-button[data-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    setTool(button.dataset.tool);
    if (button.dataset.tool === "pan") showToast("Pan tool · drag to move");
    if (button.dataset.tool === "zoom") showToast("Zoom tool · drag vertically");
    if (button.dataset.tool === "orbit") showToast("Orbit tool · drag to rotate");
  });
});

$("#frameBtn").addEventListener("click", () => {
  stopIntro();
  frameCase(state.activeCaseId, true);
  showToast("Framed selected solid");
});

$("#resetViewBtn").addEventListener("click", () => {
  stopIntro();
  frameCase(state.activeCaseId, true);
  showToast("View reset");
});

$("#washerQuickBtn").addEventListener("click", () => {
  stopIntro();
  setPlaying(false);
  setApproxEnabled(!state.approx);
});

$("#railWire").addEventListener("click", () => {
  stopIntro();
  setShading(state.mode === "wire" ? "solid" : "wire");
});

$("#railGrid").addEventListener("click", () => {
  toggleGrid();
});

$("#railHelp").addEventListener("click", () => openModal());

/* -------------------------------------------------------------------------- */
/* Top bar menus, actions, modal, and fullscreen                              */
/* -------------------------------------------------------------------------- */

function closeMenus() {
  $$(".menu-wrap.open").forEach((wrapper) => wrapper.classList.remove("open"));
  $$(".menu-trigger").forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
}

$$(".menu-trigger").forEach((trigger) => {
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const wrapper = trigger.closest(".menu-wrap");
    const wasOpen = wrapper.classList.contains("open");
    closeMenus();
    if (!wasOpen) {
      wrapper.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
    }
  });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) closeMenus();
});

$$(".menu-popover [data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    closeMenus();
    handleAction(button.dataset.action);
  });
});

$$("[data-action]").forEach((button) => {
  if (button.closest(".menu-popover")) return;
  button.addEventListener("click", () => handleAction(button.dataset.action));
});

function handleAction(action) {
  switch (action) {
    case "screenshot":
      exportViewport();
      break;
    case "fullscreen":
      toggleFullscreen();
      break;
    case "reset-settings":
      resetStudy();
      break;
    case "frame":
      frameCase(state.activeCaseId, true);
      showToast("Framed selected solid");
      break;
    case "toggle-grid":
      toggleGrid();
      break;
    case "shading-wire":
      setShading(state.mode === "wire" ? "solid" : "wire");
      break;
    case "shading-xray":
      setShading(state.mode === "xray" ? "solid" : "xray");
      break;
    case "cutaway":
      stopIntro();
      setPlaying(false);
      setAngle(270);
      showToast("Quarter cutaway · 270°");
      break;
    case "about":
    case "shortcuts":
      openModal();
      break;
    case "builder":
      openBuilder();
      break;
    default:
      break;
  }
}

function openModal() {
  closeBuilder();
  const modal = $("#aboutModal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $("#modalClose").focus();
}

function closeModal() {
  const modal = $("#aboutModal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

$("#modalClose").addEventListener("click", closeModal);
$("#aboutModal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeModal();
});

/* -------------------------------------------------------------------------- */
/* Custom problem builder                                                     */
/* -------------------------------------------------------------------------- */

let lastInterpretation = "";

function openBuilder() {
  closeModal();
  const modal = $("#builderModal");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");

  if (currentProblem.id === "custom" && currentProblem.raw) {
    $("#customName").value = currentProblem.title;
    $("#customUpper").value = currentProblem.raw.upper;
    $("#customLower").value = currentProblem.raw.lower;
    $("#customXMin").value = formatInputValue(currentProblem.raw.xMin);
    $("#customXMax").value = formatInputValue(currentProblem.raw.xMax);
    $("#customAxis").value = formatInputValue(currentProblem.raw.axis);
    $("#builderQuestion").value =
      currentProblem.raw.question || currentProblem.region.description || "";
    lastInterpretation =
      currentProblem.raw.explanation || currentProblem.region.description || "";
    $("#builderEndpoint").textContent = "Editing the current custom problem";
    setParseStatus("Editing the current custom problem · re-interpret or edit below");
  } else {
    $("#builderEndpoint").textContent = "Ready";
    setParseStatus("Fast JSON extraction · local proxy");
  }

  hideBuilderError();
  setParseLoading(false);
  window.setTimeout(() => $("#builderQuestion").focus(), 60);
}

function closeBuilder() {
  const modal = $("#builderModal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  aiRequestSerial += 1;
  setParseLoading(false);
}

function showBuilderError(message) {
  const error = $("#builderError");
  error.textContent = message;
  error.hidden = false;
}

function hideBuilderError() {
  const error = $("#builderError");
  error.hidden = true;
  error.textContent = "";
}

function setParseLoading(loading) {
  const button = $("#interpretBtn");
  button.disabled = loading;
  button.classList.toggle("is-loading", loading);
  $(".interpret-label", button).textContent = loading
    ? "Interpreting…"
    : "Interpret with OpenCode Go";
  $("#renderCustomBtn").disabled = loading;
}

function setParseStatus(message, tone = "") {
  const status = $("#parseStatus");
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-success", tone === "success");
}

function prettyModelName(model) {
  if (!model) return "OpenCode Go";
  const id = model.split(":")[0];
  const names = {
    "gpt-6-luna": "GPT-6 Luna",
    "hy4-flash-free": "Hy4 Flash",
    "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
    "claude-haiku-5-5": "Claude Haiku 5.5",
  };
  return names[id] || id;
}

function formatInputValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  if (Math.abs(number) < 1e-12) return "0";
  const specials = [
    [Math.PI, "pi"],
    [-Math.PI, "-pi"],
    [Math.PI / 2, "pi/2"],
    [-Math.PI / 2, "-pi/2"],
    [Math.PI / 3, "pi/3"],
    [-Math.PI / 3, "-pi/3"],
    [Math.PI / 4, "pi/4"],
    [-Math.PI / 4, "-pi/4"],
    [Math.PI * 2, "2*pi"],
    [-Math.PI * 2, "-2*pi"],
  ];
  for (const [special, label] of specials) {
    if (Math.abs(number - special) < 1e-6 * Math.max(1, Math.abs(special))) {
      return label;
    }
  }
  return formatNumber(number, 6);
}

function fillManualFields(problem) {
  $("#customName").value = problem.title || "Custom solid";
  $("#customUpper").value = problem.upper;
  $("#customLower").value = problem.lower;
  $("#customXMin").value = formatInputValue(problem.xMin);
  $("#customXMax").value = formatInputValue(problem.xMax);
  $("#customAxis").value = formatInputValue(problem.axisY);
}

async function interpretQuestion() {
  const question = $("#builderQuestion").value.trim();
  if (question.length < 8) {
    setParseStatus("Add a few more details to the question.", "error");
    $("#builderQuestion").focus();
    return;
  }

  const serial = ++aiRequestSerial;
  hideBuilderError();
  setParseLoading(true);
  setParseStatus("Contacting the local OpenCode service…");
  const started = performance.now();

  try {
    const response = await fetch("/api/interpret", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(35_000),
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload?.ok) {
      throw new Error(
        payload?.error ||
          "The interpreter could not turn that question into a region.",
      );
    }
    if (serial !== aiRequestSerial) return;

    fillManualFields(payload.problem);
    lastInterpretation = payload.problem.explanation || "";

    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    const modelName = prettyModelName(payload.meta?.model);
    setParseStatus(
      payload.meta?.cached
        ? `Parsed instantly · ${modelName} · review the values below`
        : `Parsed in ${elapsed}s · ${modelName} · review the values below`,
      "success",
    );
    $("#builderEndpoint").textContent = payload.meta?.cached
      ? "Cached interpretation"
      : `${modelName} · ${elapsed}s`;
    $("#renderCustomBtn").focus();
  } catch (error) {
    if (serial !== aiRequestSerial) return;
    setParseStatus("Interpreter unavailable · fill in the values manually", "error");
    showBuilderError(
      `${error.message} You can still enter the boundaries, interval, and rotation line by hand.`,
    );
    $("#builderEndpoint").textContent = "Manual input available";
  } finally {
    if (serial === aiRequestSerial) setParseLoading(false);
  }
}

function submitCustomProblem(event) {
  event.preventDefault();
  hideBuilderError();

  try {
    const { problem } = buildCustomProblem({
      name: $("#customName").value,
      question: $("#builderQuestion").value,
      upper: $("#customUpper").value,
      lower: $("#customLower").value,
      xMin: $("#customXMin").value,
      xMax: $("#customXMax").value,
      axis: $("#customAxis").value,
      explanation: lastInterpretation,
    });

    problemRegistry.set("custom", problem);
    closeBuilder();
    setShading("solid", { silent: true });
    loadProblem(problem, {
      variantId: "custom",
      animateCamera: true,
    });
    setAngle(360);
    showToast("Custom solid rendered · adjust the axis in the timeline");
  } catch (error) {
    showBuilderError(error.message);
    $("#builderEndpoint").textContent = "Validation failed";
  }
}

$("#builderClose").addEventListener("click", closeBuilder);
$("#builderModal").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeBuilder();
});
$("#builderForm").addEventListener("submit", submitCustomProblem);
$("#interpretBtn").addEventListener("click", interpretQuestion);

$$("[data-example]").forEach((button) => {
  button.addEventListener("click", () => {
    $("#builderQuestion").value = button.dataset.example;
    $("#builderQuestion").focus();
    setParseStatus("Example loaded · interpret it or edit the fields below");
    hideBuilderError();
  });
});

$("#fillExampleBtn").addEventListener("click", () => {
  $("#builderQuestion").value =
    "The region bounded by y = -x^2 + 4x and the x-axis is rotated about y = -1.";
  fillManualFields({
    title: "Parabolic cap",
    upper: "-x^2 + 4*x",
    lower: "0",
    xMin: 0,
    xMax: 4,
    axisY: -1,
  });
  lastInterpretation = "";
  setParseStatus("Parabola loaded · render or interpret it");
  hideBuilderError();
});

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
  } catch {
    showToast("Fullscreen is not available in this browser");
  }
}

$("#screenshotBtn").addEventListener("click", exportViewport);
$("#fullscreenBtn").addEventListener("click", toggleFullscreen);
$("#panelToggle").addEventListener("click", () => {
  const panel = $("#propertiesPanel");
  const open = panel.classList.toggle("open");
  $("#panelToggle").setAttribute("aria-expanded", String(open));
});

function exportViewport() {
  const oldAlpha = renderer.getClearAlpha();
  const oldColor = new THREE.Color();
  renderer.getClearColor(oldColor);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);

  const width = renderer.domElement.width;
  const height = renderer.domElement.height;
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = width;
  exportCanvas.height = height;
  const ctx = exportCanvas.getContext("2d");
  const gradient = ctx.createRadialGradient(
    width * 0.52,
    height * 0.36,
    0,
    width * 0.51,
    height * 0.4,
    Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, "#252b31");
  gradient.addColorStop(0.4, "#181c21");
  gradient.addColorStop(1, "#0d1014");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(renderer.domElement, 0, 0);

  const link = document.createElement("a");
  link.download = `revolve-study-${activeCase?.id || "a"}-${Math.round(state.angle)}deg.png`;
  link.href = exportCanvas.toDataURL("image/png");
  link.click();

  renderer.setClearColor(oldColor, oldAlpha);
  showToast("Viewport exported as PNG");
}

/* -------------------------------------------------------------------------- */
/* Keyboard shortcuts                                                         */
/* -------------------------------------------------------------------------- */

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenus();
    closeModal();
    closeBuilder();
    if (window.innerWidth <= 900) {
      $("#propertiesPanel").classList.remove("open");
      $("#panelToggle").setAttribute("aria-expanded", "false");
    }
    return;
  }

  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    exportViewport();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.code === "Space") {
    event.preventDefault();
    stopIntro();
    togglePlay();
    return;
  }

  switch (event.key.toLowerCase()) {
    case "1":
    case "2":
    case "3": {
      const index = Number(event.key) - 1;
      const variant = currentProblem.variants[index];
      if (variant) selectCase(variant.id);
      break;
    }
    case "n":
      openBuilder();
      break;
    case "4":
      stopIntro();
      setPlaying(false);
      setAngle(270);
      showToast("Quarter cutaway · 270°");
      break;
    case "5":
      stopIntro();
      setPlaying(false);
      setAngle(0);
      break;
    case "6":
      stopIntro();
      setPlaying(false);
      setAngle(360);
      break;
    case "f":
      frameCase(state.activeCaseId, true);
      showToast("Framed selected solid");
      break;
    case "g":
      toggleGrid();
      break;
    case "w":
      setShading(state.mode === "wire" ? "solid" : "wire");
      break;
    case "x":
      setShading(state.mode === "xray" ? "solid" : "xray");
      break;
    case "r":
      if (event.shiftKey) {
        resetStudy();
      } else {
        frameCase(state.activeCaseId, true);
        showToast("View reset");
      }
      break;
    case "?":
      openModal();
      break;
    default:
      break;
  }
});

/* -------------------------------------------------------------------------- */
/* View gizmo                                                                 */
/* -------------------------------------------------------------------------- */

const gizmoItems = [
  {
    group: $("#gizmoX"),
    vector: new THREE.Vector3(1, 0, 0),
  },
  {
    group: $("#gizmoY"),
    vector: new THREE.Vector3(0, 1, 0),
  },
  {
    group: $("#gizmoZ"),
    vector: new THREE.Vector3(0, 0, 1),
  },
];

function updateGizmo() {
  const inverseCamera = camera.quaternion.clone().invert();
  for (const item of gizmoItems) {
    const direction = item.vector.clone().applyQuaternion(inverseCamera);
    const radius = 26;
    const x = 44 + direction.x * radius;
    const y = 44 - direction.y * radius;
    const line = item.group.querySelector("line");
    const circle = item.group.querySelector("circle");
    const text = item.group.querySelector("text");
    line.setAttribute("x1", "44");
    line.setAttribute("y1", "44");
    line.setAttribute("x2", x.toFixed(2));
    line.setAttribute("y2", y.toFixed(2));
    circle.setAttribute("cx", x.toFixed(2));
    circle.setAttribute("cy", y.toFixed(2));
    text.setAttribute("x", x.toFixed(2));
    text.setAttribute("y", y.toFixed(2));
    item.group.setAttribute(
      "opacity",
      (direction.z > 0 ? 0.96 : 0.48 + direction.z * 0.16).toFixed(3),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Resize, animation, and boot                                                */
/* -------------------------------------------------------------------------- */

function resize() {
  const width = Math.max(viewport.clientWidth, 1);
  const height = Math.max(viewport.clientHeight, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

const resizeObserver = new ResizeObserver(() => resize());
resizeObserver.observe(viewport);
window.addEventListener("resize", resize);

controls.addEventListener("start", () => {
  stopIntro();
  cameraTween = null;
});

renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

function animateCamera(now) {
  if (!cameraTween) return;
  const progress = clamp(
    (now - cameraTween.start) / cameraTween.duration,
    0,
    1,
  );
  const eased =
    progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  camera.position.lerpVectors(
    cameraTween.fromPosition,
    cameraTween.toPosition,
    eased,
  );
  controls.target.lerpVectors(
    cameraTween.fromTarget,
    cameraTween.toTarget,
    eased,
  );
  if (progress >= 1) cameraTween = null;
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (introAnimation) {
    const progress = clamp(
      (now - introAnimation.start) / introAnimation.duration,
      0,
      1,
    );
    const eased = 1 - Math.pow(1 - progress, 3);
    setAngle(360 * eased);
    if (progress >= 1) {
      introAnimation = null;
      setAngle(360);
    }
  } else if (state.playing) {
    const next = state.angle + dt * 145;
    setAngle(next);
    if (next >= 360) {
      setAngle(360);
      setPlaying(false);
    }
  }

  animateCamera(now);
  controls.update();
  updateGizmo();
  renderer.render(scene, camera);

  fpsFrames += 1;
  fpsTime += dt;
  if (fpsTime >= 0.65) {
    $("#fpsReadout").textContent = `${Math.round(fpsFrames / fpsTime)} FPS`;
    fpsFrames = 0;
    fpsTime = 0;
  }

  if (now - lastTriangleUpdate > 900) {
    lastTriangleUpdate = now;
    if (activeSolid) {
      $("#triangleCount").textContent = `${numberFormat.format(countTriangles())} tris`;
    }
  }
}

function boot() {
  resize();
  loadProblem(PRESET_PROBLEM, {
    variantId: "a",
    animateCamera: false,
    announce: false,
  });
  setTool("orbit");
  setShadingButtonState("solid");
  $("#railGrid").classList.add("active");
  setAngle(360);
  updateApproxUI();

  requestAnimationFrame(() => {
    resize();
    frameCase(state.activeCaseId, false);
    if (!reducedMotion) {
      introAnimation = {
        start: performance.now() + 520,
        duration: 2400,
      };
    }
  });

  requestAnimationFrame(animate);
}

boot();
