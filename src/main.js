import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  analyzeLines,
  formatBound,
  isImplicitEquationInput,
  prettyExpression,
} from "./region.js";
import { createRevolvedSolid, disposeRevolvedSolid } from "./solid.js";
import { RegionPlot } from "./plot2d.js";
import { formatNumber } from "./expression.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const COLORS = [
  "#ff9950",
  "#4bd7c2",
  "#6e9fff",
  "#c5a3ff",
  "#73dda8",
  "#e9c46a",
  "#ed7b6d",
];

const appShell = $("#appShell");
const viewport = $("#viewport");
const canvas = $("#sceneCanvas");
const plotCanvas = $("#plotCanvas");
const plot = new RegionPlot(plotCanvas);
const qualityRenderScale = Math.min(window.devicePixelRatio || 1, 1.25);
const wireRenderScale = Math.min(window.devicePixelRatio || 1, 3);
let renderScale = qualityRenderScale;

const state = {
  lines: [
    { id: "line-1", text: "-x^2 + 4x", color: COLORS[0] },
    { id: "line-2", text: "0", color: COLORS[1] },
  ],
  axisText: "y = 0",
  lineSequence: 2,
  newLineId: null,
  model: null,
  solid: null,
  view: "2d",
  mode: "solid",
  grid: true,
  playing: false,
  interacting: false,
  sweep: 360,
  stale: true,
  cameraTween: null,
  playAfterCamera: false,
  analyzeTimer: 0,
  lineErrorId: null,
  lastTime: performance.now(),
  fpsFrames: 0,
  fpsWindowStart: performance.now(),
  lowFpsWindows: 0,
  animationFrame: 0,
  needsRender: true,
  lastTriangleUpdate: 0,
  idleTimer: 0,
};

/* -------------------------------------------------------------------------- */
/* Renderer, scene, camera                                                    */
/* -------------------------------------------------------------------------- */

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(renderScale);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x11151a, 0.0085);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
camera.position.set(8, 6, 11);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.screenSpacePanning = true;
controls.rotateSpeed = 0.76;
controls.panSpeed = 0.72;
controls.zoomSpeed = 0.82;
controls.minDistance = 2.5;
controls.maxDistance = 90;
controls.minPolarAngle = 0.08;
controls.maxPolarAngle = Math.PI * 0.93;
controls.target.set(0, 1.5, 0);

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environmentTexture = pmrem.fromScene(room, 0.03).texture;
scene.environment = environmentTexture;
scene.environmentIntensity = 0.36;
room.dispose?.();
pmrem.dispose();

const hemi = new THREE.HemisphereLight(0xc8e2ff, 0x1b1512, 0.62);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xfff2df, 1.9);
keyLight.position.set(6.5, 8.5, 7);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x6edcd6, 0.78);
fillLight.position.set(-7, 3.8, -5);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xff8d50, 0.95);
rimLight.position.set(1.5, -4.5, -6);
scene.add(rimLight);

const topLight = new THREE.DirectionalLight(0xffffff, 0.25);
topLight.position.set(0, 12, 0);
scene.add(topLight);

/* -------------------------------------------------------------------------- */
/* One origin-centred xz grid plane                                           */
/* -------------------------------------------------------------------------- */

function makeGridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
    uniforms: {
      uOpacity: { value: 1 },
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
      uniform float uOpacity;
      varying vec3 vWorld;

      float gridMask(vec2 p, float scale) {
        vec2 c = p / scale;
        vec2 grid = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(0.00001));
        float line = min(grid.x, grid.y);
        return 1.0 - smoothstep(0.0, 1.15, line);
      }

      void main() {
        vec2 p = vWorld.xz;
        float minor = gridMask(p, 1.0);
        float major = gridMask(p, 5.0);
        float distanceFade = 1.0 - smoothstep(12.0, 34.0, length(p));

        vec3 minorColor = vec3(0.205, 0.238, 0.274);
        vec3 majorColor = vec3(0.325, 0.365, 0.414);
        vec3 color = mix(minorColor, majorColor, major);
        float alpha = (minor * 0.27 + major * 0.38) * distanceFade * uOpacity;

        if (alpha < 0.004) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

const gridMaterial = makeGridMaterial();
const grid = new THREE.Mesh(new THREE.PlaneGeometry(84, 84), gridMaterial);
grid.rotation.x = -Math.PI / 2;
grid.position.set(0, 0, 0);
grid.renderOrder = -3;
scene.add(grid);

/* -------------------------------------------------------------------------- */
/* Coordinate axes through the true origin                                    */
/* -------------------------------------------------------------------------- */

const coordinateGroup = new THREE.Group();
scene.add(coordinateGroup);

const AXIS_EXTENT = 26;
const axisMaterials = {
  x: new THREE.LineBasicMaterial({ color: 0xc6a08c, transparent: true, opacity: 0.32, depthWrite: false }),
  y: new THREE.LineBasicMaterial({ color: 0x9bbdaa, transparent: true, opacity: 0.3, depthWrite: false }),
  z: new THREE.LineBasicMaterial({ color: 0x95aed0, transparent: true, opacity: 0.3, depthWrite: false }),
};

function addCoordinateLine(start, end, material) {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const line = new THREE.Line(geometry, material);
  line.renderOrder = -1;
  coordinateGroup.add(line);
}

addCoordinateLine(
  new THREE.Vector3(-AXIS_EXTENT, 0, 0),
  new THREE.Vector3(AXIS_EXTENT, 0, 0),
  axisMaterials.x,
);
addCoordinateLine(
  new THREE.Vector3(0, -AXIS_EXTENT, 0),
  new THREE.Vector3(0, AXIS_EXTENT, 0),
  axisMaterials.y,
);
addCoordinateLine(
  new THREE.Vector3(0, 0, -AXIS_EXTENT),
  new THREE.Vector3(0, 0, AXIS_EXTENT),
  axisMaterials.z,
);

function makeAxisLabel(text, color) {
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = 96;
  labelCanvas.height = 96;
  const context = labelCanvas.getContext("2d");
  context.clearRect(0, 0, 96, 96);
  context.font = '600 46px "MesloLGS Nerd Font", monospace';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = color;
  context.fillText(text, 48, 50);
  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.1, 1.1, 1);
  sprite.renderOrder = 5;
  coordinateGroup.add(sprite);
  return sprite;
}

const axisLabels = {
  x: makeAxisLabel("x", "#d9aa91"),
  y: makeAxisLabel("y", "#a7cfb8"),
  z: makeAxisLabel("z", "#a9c1e1"),
};
axisLabels.x.position.set(AXIS_EXTENT * 0.74, 0.5, 0);
axisLabels.y.position.set(0.5, AXIS_EXTENT * 0.74, 0);
axisLabels.z.position.set(0, 0.5, AXIS_EXTENT * 0.74);

/* -------------------------------------------------------------------------- */
/* Rotation axis visual                                                       */
/* -------------------------------------------------------------------------- */

const rotationAxisMaterial = new THREE.LineDashedMaterial({
  color: 0xff9950,
  dashSize: 0.34,
  gapSize: 0.24,
  transparent: true,
  opacity: 0.9,
  depthWrite: false,
  toneMapped: false,
});
const rotationAxis = new THREE.Line(
  new THREE.BufferGeometry(),
  rotationAxisMaterial,
);
rotationAxis.visible = false;
rotationAxis.renderOrder = 2;
scene.add(rotationAxis);

function updateRotationAxisVisual(model) {
  if (!model?.axis || !model.bounds) {
    rotationAxis.visible = false;
    return;
  }
  const axis = model.axis;
  const extension = Math.max(
    12,
    (model.bounds.xMax - model.bounds.xMin) * 1.35,
    (model.bounds.yMax - model.bounds.yMin) * 1.7,
  );
  const first = axis.pointAt(-extension, 0);
  const second = axis.pointAt(extension, 0);
  rotationAxis.geometry.dispose();
  rotationAxis.geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(first.x, first.y, 0),
    new THREE.Vector3(second.x, second.y, 0),
  ]);
  rotationAxis.computeLineDistances();
  rotationAxis.visible = state.view === "3d";
}

/* -------------------------------------------------------------------------- */
/* Camera and render loop                                                     */
/* -------------------------------------------------------------------------- */

function requestRender() {
  state.needsRender = true;
  if (state.animationFrame) return;
  state.animationFrame = requestAnimationFrame(tick);
}

function cancelCameraTween() {
  state.cameraTween = null;
}

function tweenCamera(position, target, duration = 880) {
  if (reducedMotion) {
    camera.position.copy(position);
    controls.target.copy(target);
    camera.lookAt(target);
    requestRender();
    return;
  }
  state.cameraTween = {
    start: performance.now(),
    duration,
    fromPosition: camera.position.clone(),
    toPosition: position.clone(),
    fromTarget: controls.target.clone(),
    toTarget: target.clone(),
  };
  requestRender();
}

function frameSolid(options = {}) {
  const { animate = true, fromHigh = false } = options;
  if (!state.solid) return;
  state.solid.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(state.solid.group);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const target = sphere.center.clone();
  const radius = Math.max(sphere.radius, 0.8);
  const aspect = Math.max(viewport.clientWidth / viewport.clientHeight, 0.35);
  const vFov = camera.fov * DEG;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fitFov = Math.min(vFov, hFov);
  const distance = (radius / Math.sin(fitFov / 2)) * 1.12;
  const direction = new THREE.Vector3(0.72, 0.36, 1.02).normalize();
  const position = target.clone().addScaledVector(direction, distance);

  if (fromHigh) {
    camera.position.set(
      target.x - radius * 0.4,
      target.y + distance * 0.92,
      target.z + distance * 0.9,
    );
    controls.target.copy(target);
    camera.lookAt(target);
  }

  if (animate) {
    tweenCamera(position, target, 960);
  } else {
    cancelCameraTween();
    camera.position.copy(position);
    controls.target.copy(target);
    camera.lookAt(target);
    controls.update();
    requestRender();
  }
}

function updateCameraTween(now) {
  const tween = state.cameraTween;
  if (!tween) return false;
  const progress = clamp((now - tween.start) / tween.duration, 0, 1);
  const eased =
    progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
  camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
  controls.update();
  if (progress >= 1) {
    state.cameraTween = null;
    if (state.playAfterCamera && state.view === "3d" && state.solid) {
      state.playAfterCamera = false;
      setPlaying(true);
    }
  }
  return true;
}

function setRenderScale(scale) {
  const cap = state.mode === "wire" ? wireRenderScale : qualityRenderScale;
  const next = clamp(scale, 0.75, cap);
  if (Math.abs(next - renderScale) < 0.01) return;
  renderScale = next;
  const width = Math.max(viewport.clientWidth, 1);
  const height = Math.max(viewport.clientHeight, 1);
  renderer.setPixelRatio(renderScale);
  renderer.setSize(width, height, false);
  requestRender();
}

function updateFps(now) {
  if (now - state.fpsWindowStart < 650) return;
  const seconds = (now - state.fpsWindowStart) / 1000;
  const readout = $("#fpsReadout");
  const fps = state.fpsFrames / seconds;
  if (state.fpsFrames === 0) {
    readout.textContent = "IDLE";
  } else {
    readout.textContent = `${Math.round(fps)} FPS`;
  }
  const active =
    state.mode !== "wire" &&
    (state.interacting || state.playing || Boolean(state.cameraTween));
  if (active && fps > 0) {
    if (fps < 50) {
      state.lowFpsWindows += 1;
    } else {
      state.lowFpsWindows = 0;
    }
    if (state.lowFpsWindows >= 2) {
      state.lowFpsWindows = 0;
      if (renderScale > 1.0) {
        setRenderScale(Math.max(1.0, renderScale - 0.15));
      } else if (fps < 38 && renderScale > 0.85) {
        setRenderScale(0.85);
      } else if (fps < 30 && renderScale > 0.75) {
        setRenderScale(0.75);
      }
    }
  }
  state.fpsFrames = 0;
  state.fpsWindowStart = now;
}

function tick(now) {
  state.animationFrame = 0;
  const dt = Math.min((now - state.lastTime) / 1000, 0.05);
  state.lastTime = now;

  let active = false;
  if (updateCameraTween(now)) active = true;

  if (state.playing && state.view === "3d") {
    const next = state.sweep + dt * 145;
    setSweep(next, { ui: true, quiet: true });
    if (next >= 360) {
      setSweep(360, { ui: true, quiet: true });
      setPlaying(false);
    }
    active = true;
  }

  updateGizmo();

  if (state.needsRender || active) {
    renderer.render(scene, camera);
    state.needsRender = false;
    state.fpsFrames += 1;
  }
  updateFps(now);

  if (!active && !state.needsRender) {
    window.clearTimeout(state.idleTimer);
    state.idleTimer = window.setTimeout(() => {
      if (!state.animationFrame && !state.playing && !state.cameraTween) {
        $("#fpsReadout").textContent = "IDLE";
      }
    }, 900);
  }

  if (now - state.lastTriangleUpdate > 900) {
    state.lastTriangleUpdate = now;
    updateTriangleCount();
  }

  if (active) requestRender();
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                     */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function prettyMathHTML(value) {
  let text = escapeHtml(prettyExpression(value));
  text = text
    .replace(/\^((?:−|-)?\d+)/g, "<sup>$1</sup>")
    .replace(/sqrt\s*\(/g, "√(")
    .replace(/cbrt\s*\(/g, "∛(")
    .replace(/\bpi\b/g, "π")
    .replace(/\btau\b/g, "τ")
    .replace(/\*/g, " · ");
  return text;
}

function lineColor(index) {
  return COLORS[index % COLORS.length];
}

function nextLineColor() {
  const used = new Set(state.lines.map((line) => line.color));
  return COLORS.find((color) => !used.has(color)) || lineColor(state.lines.length);
}

function buildLineRows() {
  const list = $("#lineList");
  list.replaceChildren();

  const empty = state.lines.length === 0;
  $("#editorPanel").classList.toggle("is-empty", empty);
  $("#lineEmpty").hidden = !empty;
  if (empty) $("#autoBoundaryNote").hidden = true;

  state.lines.forEach((line, index) => {
    const row = document.createElement("div");
    row.className = "line-row";
    row.dataset.lineId = line.id;
    if (state.lineErrorId === line.id) row.classList.add("has-error");
    if (state.newLineId === line.id) row.classList.add("is-new");

    const swatch = document.createElement("span");
    swatch.className = "line-swatch";
    swatch.style.background = line.color;
    swatch.style.boxShadow = `0 0 0 3px ${hexToRgba(line.color, 0.09)}`;

    const input = document.createElement("input");
    input.className = "expression-input line-input";
    input.type = "text";
    input.value = line.text;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.setAttribute("aria-label", `Line ${index + 1}`);
    input.placeholder =
      index === 0
        ? "y = -x^2 + 4x   or   x^2 + y^2 = 1"
        : index === 1
          ? "y = 0   or   x = 4"
          : "y = sin(x)   or   x^2 + y^2 = 4";
    input.addEventListener("input", (event) => {
      updateLineText(line.id, event.target.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        generateSolid();
      }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "line-remove";
    remove.textContent = "×";
    remove.title = "Remove line";
    remove.setAttribute("aria-label", `Remove line ${index + 1}`);
    remove.addEventListener("click", () => removeLine(line.id));

    row.append(swatch, input, remove);

    const error = document.createElement("div");
    error.className = "line-error";
    error.hidden = true;
    row.append(error);
    list.append(row);
  });
}

function updateLineErrorMessages() {
  for (const row of $$(".line-row")) {
    const id = row.dataset.lineId;
    const error = $(".line-error", row);
    const hasError = state.lineErrorId === id;
    row.classList.toggle("has-error", hasError);
    error.hidden = !hasError;
    error.textContent = hasError ? state.model?.error || "Check this line." : "";
  }
}

function updateLineText(id, text) {
  const line = state.lines.find((entry) => entry.id === id);
  if (!line) return;
  line.text = text;
  switchToGraphIfNeeded();
  scheduleAnalyze();
}

function addLine() {
  const id = `line-${++state.lineSequence}`;
  state.lines.push({
    id,
    text: "",
    color: nextLineColor(),
  });
  state.newLineId = id;
  buildLineRows();
  const input = $(`.line-row[data-line-id="${id}"] .line-input`);
  input?.focus();
  window.setTimeout(() => {
    state.newLineId = null;
    $(`.line-row[data-line-id="${id}"]`)?.classList.remove("is-new");
  }, 900);
  switchToGraphIfNeeded();
  scheduleAnalyze();
}

function removeLine(id) {
  state.lines = state.lines.filter((line) => line.id !== id);
  buildLineRows();
  switchToGraphIfNeeded();
  scheduleAnalyze();
}

function switchToGraphIfNeeded() {
  state.stale = true;
  if (state.view === "3d") {
    setView("2d", { stopPlayback: true });
  }
}

$("#addLineBtn").addEventListener("click", addLine);

$("#axisInput").addEventListener("input", (event) => {
  state.axisText = event.target.value;
  switchToGraphIfNeeded();
  scheduleAnalyze();
});

$("#axisInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    generateSolid();
  }
});

$$("[data-axis-example]").forEach((button) => {
  button.addEventListener("click", () => {
    const axis = button.dataset.axisExample;
    state.axisText = axis;
    $("#axisInput").value = axis;
    switchToGraphIfNeeded();
    analyzeNow({ fit: true });
  });
});

function scheduleAnalyze() {
  window.clearTimeout(state.analyzeTimer);
  state.analyzeTimer = window.setTimeout(() => analyzeNow({ fit: true }), 90);
}

function countFunctionLines(lines = state.lines) {
  return lines.filter((line) => {
    const text = String(line.text ?? "").trim();
    return text && !/^\s*x\s*=/i.test(text);
  }).length;
}

function hasImplicitLine(lines = state.lines) {
  return lines.some((line) => {
    const text = String(line.text ?? "").trim();
    return text && isImplicitEquationInput(text);
  });
}

function shouldAutoClose(lines = state.lines) {
  return !hasImplicitLine(lines) && countFunctionLines(lines) === 1;
}

function effectiveInputs() {
  if (!shouldAutoClose()) return state.lines;
  return [
    ...state.lines,
    {
      id: "__auto-x-axis",
      text: "y = 0",
      color: "#7f8a95",
      implicit: true,
      hidden: true,
      role: "x-axis",
    },
    {
      id: "__auto-y-axis",
      text: "x = 0",
      color: "#7f8a95",
      implicit: true,
      hidden: true,
      role: "y-axis",
    },
  ];
}

function analyzeNow(options = {}) {
  const { fit = false } = options;
  const empty = state.lines.length === 0;
  const autoAxes = shouldAutoClose();
  $("#autoBoundaryNote").hidden = !autoAxes;

  let model;
  if (empty) {
    model = {
      ok: false,
      error: "Add a line to begin.",
      lines: [],
      axis: null,
    };
  } else {
    model = analyzeLines(effectiveInputs(), state.axisText, {
      clipXMin: autoAxes ? 0 : null,
      clipYMin: autoAxes ? 0 : null,
    });
    if (
      autoAxes &&
      !model.ok &&
      /No enclosed region/i.test(model.error)
    ) {
      model.error =
        "With one line, the x-axis and y-axis close the region in the first quadrant. This curve still needs a finite side boundary — add a vertical line such as x = 4 or a domain restriction.";
    }
  }
  state.model = model;
  state.lineErrorId = model.lineId || null;

  if (!plot.userAdjusted) plot.autoFit = true;
  plot.setModel(model);
  if (fit && model.ok && !plot.userAdjusted) {
    plot.fit();
  }

  updateEditorError();
  updateLineErrorMessages();
  updateResults();
  updateChrome();
  updateRotationAxisVisual(model);

  const generateButton = $("#generateBtn");
  generateButton.disabled = !model.ok;
  $("#generateLabel").textContent = state.solid ? "Update solid" : "Generate solid";

  $("#graphEmpty").hidden = model.ok;
  if (!model.ok) {
    $("#graphEmpty").innerHTML = "";
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    if (empty) {
      title.textContent = "Start with a line";
      detail.textContent = "Use Add line to enter y = f(x), x = c, or an implicit equation such as x^2 + y^2 = 1.";
      $("#statusMessage").textContent = "2D graph · add a line to begin";
    } else {
      title.textContent = "Check the expressions";
      detail.textContent = model.error || "Add a region to continue.";
    }
    $("#graphEmpty").append(title, detail);
  }

  return model;
}

function updateEditorError() {
  const error = $("#editorError");
  const model = state.model;
  if (model?.ok || !model) {
    error.hidden = true;
    error.textContent = "";
    return;
  }
  error.hidden = false;
  error.textContent = model.error;
}

function updateChrome() {
  const model = state.model;
  const axisLabel = model?.axis?.label || "—";
  const firstLine = state.lines.find((line) => line.text.trim());
  $("#brandProject").textContent = firstLine
    ? truncate(prettyExpression(firstLine.text), 24)
    : "Untitled region";
  $("#topbarScene").textContent =
    state.view === "3d"
      ? `Local math · 3D solid${state.stale ? " · update" : ""}`
      : "Local math · 2D graph";
  $("#axisChipLabel").textContent = axisLabel;
  $("#graphAxisChip").textContent = `ROTATION · ${axisLabel}`;
  $("#graphAxisChip").hidden = !model?.axis;

  if (model?.ok) {
    const firstCell = model.cells[0];
    const equation = `${prettyExpression(firstCell.lowerLine.source)} ≤ y ≤ ${prettyExpression(
      firstCell.upperLine.source,
    )}`;
    $("#sceneEquation").textContent = equation;
    $("#objectName").textContent = `About ${axisLabel}`;
    $("#objectMethod").textContent = model.method;
    $("#caseCrumb").textContent = "REGION";
    $("#sceneDot").style.background =
      state.mode === "xray" ? "#6e9fff" : state.mode === "wire" ? "#c5a3ff" : "#ff9950";
    $("#statusMessage").textContent =
      state.view === "3d"
        ? `Solid · ${model.method.toLowerCase()} · ${Math.round(state.sweep)}°`
        : "2D graph · drag to pan · scroll to zoom";
    document.title = `Revolve Lab — ${model.method}`;
  } else {
    $("#sceneEquation").textContent = "—";
    $("#objectName").textContent = "Unresolved region";
    $("#objectMethod").textContent = "Add an enclosed region";
    document.title = "Revolve Lab — Solids of Revolution";
    $("#statusMessage").textContent = "2D graph · adjust the expressions";
  }
}

function truncate(text, length) {
  const value = String(text);
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/* -------------------------------------------------------------------------- */
/* Results and formulas                                                       */
/* -------------------------------------------------------------------------- */

function updateResults() {
  const model = state.model;
  const results = $("#results");
  if (!model?.ok) {
    results.hidden = true;
    return;
  }
  results.hidden = false;

  const exact = model.exact;
  const card = $(".volume-card");
  card.classList.toggle("is-numeric", !exact);
  $("#volumeEyebrow").textContent = exact ? "EXACT VOLUME" : "NUMERICAL VOLUME";
  $("#methodBadge").textContent = model.method.toUpperCase();

  if (exact) {
    const expression = Boolean(exact.expression);
    $("#volumeFraction").classList.toggle("is-expression", expression);
    $("#volumeFraction").classList.toggle(
      "is-integer",
      !expression && exact.denominator === 1,
    );
    if (expression) {
      $("#volumeNumerator").textContent = exact.label;
      $("#volumeDenominator").textContent = "";
    } else {
      $("#volumeNumerator").textContent =
        exact.denominator === 1
          ? `${exact.numerator}π`
          : Math.abs(exact.numerator) === 1
            ? `${exact.numerator < 0 ? "−" : ""}π`
            : `${exact.numerator}π`;
      $("#volumeDenominator").textContent = String(exact.denominator);
    }
  } else {
    $("#volumeFraction").classList.remove("is-expression", "is-integer");
  }
  $("#volumeDecimal").textContent = model.volume.toFixed(3);
  $("#volumeCaption").textContent = model.formula.note;
  $("#methodMini").textContent =
    model.method === "Disk method"
      ? "DISK"
      : model.method === "Washer method"
        ? "WASHER"
        : "SLICES";
  $("#formulaBlock").innerHTML = buildFormulaHTML(model);
  $("#formulaResult").innerHTML = buildResultHTML(model);
  $("#formulaNote").textContent = model.axis.isHorizontal
    ? `${model.formula.note} All radii are measured from ${model.axis.label}.`
    : `${model.formula.note} ${model.formula.variable} is measured along ${model.axis.label}; R and r are perpendicular distances.`;
  $("#regionReadout").textContent = describeRegion(model);
}

function describeRegion(model) {
  const parts = model.cells.slice(0, 3).map((cell) => {
    return `${formatBound(cell.a)} ≤ x ≤ ${formatBound(cell.b)} · ${prettyExpression(
      cell.lowerLine.source,
    )} ≤ y ≤ ${prettyExpression(cell.upperLine.source)}`;
  });
  if (model.cells.length > 3) parts.push("…");
  return parts.join("   ·   ");
}

function buildIntegralHTML(term, model, index) {
  const oblique = model.formula.kind === "oblique";
  const genericRadii = oblique && !term.explicitRadii;
  const lower = oblique ? formatBound(term.uStart, 3) : formatBound(term.a);
  const upper = oblique ? formatBound(term.uEnd, 3) : formatBound(term.b);
  const variable = model.formula.variable || (oblique ? "u" : "x");
  const differential = `d${variable}`;
  const outerSource = prettyMathHTML(term.outerText);
  const innerSource = prettyMathHTML(term.innerText);
  const isDisk = term.innerText === "0";
  const compact =
    genericRadii ||
    model.formula.terms.length > 1 ||
    outerSource.length + innerSource.length > 32;
  const outer = compact ? `R(${variable})` : outerSource;
  const inner = compact ? `r(${variable})` : innerSource;

  const prefix =
    index === 0
      ? `<span>V</span><span class="formula-eq">=</span>`
      : `<span class="formula-eq">+</span>`;
  const pi = `<span>π</span>`;
  const integral = `<span class="formula-int"><span class="formula-int-symbol">∫</span><span class="formula-limits"><sup>${upper}</sup><sub>${lower}</sub></span></span>`;
  const outerPower = `<span class="formula-power"><span class="formula-bracket">[</span><span>${outer}</span><span class="formula-bracket">]</span><sup>2</sup></span>`;
  const innerPower = isDisk
    ? ""
    : `<span class="formula-eq">−</span><span class="formula-power"><span class="formula-bracket">[</span><span>${inner}</span><span class="formula-bracket">]</span><sup>2</sup></span>`;

  const radii = genericRadii
    ? ""
    : `<div class="formula-row formula-radii"><span class="formula-eq">R(${variable})</span><span>=</span><span>${outerSource}</span></div>${
        isDisk
          ? ""
          : `<div class="formula-row formula-radii"><span class="formula-eq">r(${variable})</span><span>=</span><span>${innerSource}</span></div>`
      }`;

  return `<div class="formula-row">${prefix}${pi}${integral}${outerPower}${innerPower}<span>${differential}</span></div>${radii}`;
}

function buildFormulaHTML(model) {
  const terms = model.formula.terms.slice(0, 3);
  const rows = terms.map((term, index) => buildIntegralHTML(term, model, index));
  if (model.formula.terms.length > 3) {
    rows.push('<div class="formula-row formula-eq">+ …</div>');
  }
  return rows.join("");
}

function buildResultHTML(model) {
  if (model.exact) {
    return `= ${escapeHtml(model.exact.label)}<span class="formula-approx">≈ ${model.volume.toFixed(
      3,
    )} u³</span>`;
  }
  return `≈ ${model.volume.toFixed(4)} u³`;
}

/* -------------------------------------------------------------------------- */
/* Generate and view switching                                                */
/* -------------------------------------------------------------------------- */

function generateSolid() {
  window.clearTimeout(state.analyzeTimer);
  const model = analyzeNow({ fit: true });
  if (!model.ok) {
    showToast("Fix the region before generating a solid");
    return;
  }

  // Build the replacement before touching the old mesh. If something goes
  // wrong, the currently displayed solid survives.
  let newSolid;
  try {
    newSolid = createRevolvedSolid(model);
  } catch (error) {
    showToast(`Could not build the solid: ${error.message}`);
    return;
  }
  newSolid.applyMode(state.mode);
  newSolid.setResolution(viewport.clientWidth, viewport.clientHeight);
  scene.add(newSolid.group);
  newSolid.group.updateMatrixWorld(true);

  const previousSolid = state.solid;
  state.solid = newSolid;
  if (previousSolid) {
    scene.remove(previousSolid.group);
    disposeRevolvedSolid(previousSolid);
  }

  state.stale = false;
  state.lowFpsWindows = 0;
  $("#generateLabel").textContent = "Update solid";

  // Updating an already-visible solid should be seamless: keep the camera and
  // the revolve angle. Resetting the sweep here made the full solid disappear
  // back to the profile for a frame, which read as a screen blink.
  const keepCurrentView = Boolean(previousSolid) && state.view === "3d";
  if (keepCurrentView) {
    state.playAfterCamera = false;
    setSweep(state.sweep, { ui: true, quiet: true });
    updateRotationAxisVisual(model);
    updateChrome();
    updateTriangleCount();
    requestRender();
  } else {
    const first3d = state.view !== "3d";
    setView("3d", { stopPlayback: true, frame: false });
    setSweep(reducedMotion ? 360 : 0, { ui: true, quiet: true });
    state.solid.updateSweep(state.sweep * DEG);
    state.playAfterCamera = !reducedMotion;
    frameSolid({ animate: !reducedMotion, fromHigh: first3d });
    if (reducedMotion) {
      setSweep(360, { ui: true, quiet: true });
      state.solid.updateSweep(TAU);
    }
    updateRotationAxisVisual(model);
    updateChrome();
    updateTriangleCount();
    requestRender();
  }

  if (window.innerWidth <= 980) $("#editorPanel").classList.remove("open");
}

function setView(view, options = {}) {
  const { stopPlayback = true, frame = true } = options;
  if (view === state.view) {
    if (view === "3d" && state.solid && frame) frameSolid({ animate: true });
    return;
  }

  state.view = view;
  appShell.classList.toggle("is-3d", view === "3d");
  $$(".view-tab").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#statusHint").textContent =
    view === "3d"
      ? "LMB orbit · RMB pan · scroll zoom"
      : "LMB pan · scroll zoom";
  updateRotationAxisVisual(state.model);

  if (view === "2d") {
    state.playAfterCamera = false;
    if (stopPlayback) setPlaying(false);
    plot.resize();
    plot.requestRender();
    requestRender();
  } else {
    if (!state.solid || state.stale) {
      generateSolid();
      return;
    }
    if (frame) frameSolid({ animate: true });
    requestRender();
  }
  updateChrome();
}

$$(".view-tab").forEach((button) => {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view === "3d" && (!state.solid || state.stale)) {
      generateSolid();
      return;
    }
    setView(view);
  });
});

$("#backToGraphBtn").addEventListener("click", () => setView("2d"));
$("#generateBtn").addEventListener("click", generateSolid);

$("#fitGraphBtn").addEventListener("click", () => {
  plot.autoFit = true;
  plot.fit({ userAction: false });
});

$("#resetViewBtn").addEventListener("click", () => {
  frameSolid({ animate: true });
  showToast("Framed the solid");
});

$("#gridBtn").addEventListener("click", () => {
  state.grid = !state.grid;
  grid.visible = state.grid;
  $("#gridBtn").classList.toggle("active", state.grid);
  requestRender();
  showToast(state.grid ? "Grid shown" : "Grid hidden");
});

$$(".shading-button").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.shading;
    if (!["solid", "xray", "wire"].includes(mode)) return;
    const previousMode = state.mode;
    state.mode = mode;
    $$(".shading-button").forEach((entry) => {
      entry.classList.toggle("active", entry.dataset.shading === mode);
    });
    state.solid?.applyMode(mode);
    gridMaterial.uniforms.uOpacity.value = mode === "wire" ? 0.42 : 1;
    if (mode === "wire") {
      setRenderScale(wireRenderScale);
    } else if (previousMode === "wire") {
      setRenderScale(qualityRenderScale);
    }
    updateChrome();
    requestRender();
  });
});

/* -------------------------------------------------------------------------- */
/* Timeline                                                                   */
/* -------------------------------------------------------------------------- */

function setSweep(degrees, options = {}) {
  const { ui = true, quiet = false } = options;
  state.sweep = clamp(degrees, 0, 360);
  state.solid?.updateSweep(state.sweep * DEG);
  if (ui) {
    $("#angleReadout").textContent = Math.round(state.sweep);
    $("#angleRange").value = state.sweep.toFixed(1);
    $("#angleRange").style.setProperty(
      "--angle-pct",
      `${(state.sweep / 360) * 100}%`,
    );
    $$("[data-angle]").forEach((button) => {
      button.classList.toggle(
        "active",
        Math.abs(Number(button.dataset.angle) - state.sweep) < 0.6,
      );
    });
    if (state.view === "3d" && state.model?.ok) {
      $("#statusMessage").textContent = `Solid · ${state.model.method.toLowerCase()} · ${Math.round(
        state.sweep,
      )}°`;
    }
    if (!quiet) {
      updateChrome();
      updateTriangleCount();
    }
  }
  requestRender();
}

function setPlaying(playing) {
  if (playing) {
    if (state.view !== "3d") return;
    state.lowFpsWindows = 0;
    if (state.sweep >= 359.5) setSweep(0, { ui: true, quiet: true });
    $("#timelineDock").classList.add("playing");
  } else {
    $("#timelineDock").classList.remove("playing");
  }
  state.playing = playing;
  if (playing) {
    requestRender();
  } else {
    updateTriangleCount();
  }
}

$("#playBtn").addEventListener("click", () => setPlaying(!state.playing));
$("#toStartBtn").addEventListener("click", () => {
  setPlaying(false);
  setSweep(0);
});
$("#toEndBtn").addEventListener("click", () => {
  setPlaying(false);
  setSweep(360);
});
$("#angleRange").addEventListener("pointerdown", () => setPlaying(false));
$("#angleRange").addEventListener("input", (event) => {
  setPlaying(false);
  setSweep(Number(event.target.value));
});
$$("[data-angle]").forEach((button) => {
  button.addEventListener("click", () => {
    setPlaying(false);
    setSweep(Number(button.dataset.angle));
  });
});

/* -------------------------------------------------------------------------- */
/* Gizmo                                                                      */
/* -------------------------------------------------------------------------- */

const gizmoItems = [
  { group: $("#gizmoX"), vector: new THREE.Vector3(1, 0, 0) },
  { group: $("#gizmoY"), vector: new THREE.Vector3(0, 1, 0) },
  { group: $("#gizmoZ"), vector: new THREE.Vector3(0, 0, 1) },
];

function updateGizmo() {
  if (state.view !== "3d") return;
  const inverseCamera = camera.quaternion.clone().invert();
  for (const item of gizmoItems) {
    const direction = item.vector.clone().applyQuaternion(inverseCamera);
    const radius = 23;
    const x = 40 + direction.x * radius;
    const y = 40 - direction.y * radius;
    const line = item.group.querySelector("line");
    const circle = item.group.querySelector("circle");
    const text = item.group.querySelector("text");
    line.setAttribute("x1", "40");
    line.setAttribute("y1", "40");
    line.setAttribute("x2", x.toFixed(2));
    line.setAttribute("y2", y.toFixed(2));
    circle.setAttribute("cx", x.toFixed(2));
    circle.setAttribute("cy", y.toFixed(2));
    text.setAttribute("x", x.toFixed(2));
    text.setAttribute("y", y.toFixed(2));
    item.group.setAttribute(
      "opacity",
      (direction.z > 0 ? 0.96 : 0.45 + direction.z * 0.12).toFixed(3),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Counts, export, fullscreen                                                */
/* -------------------------------------------------------------------------- */

function countTriangles() {
  if (!state.solid) return 0;
  let total = 0;
  state.solid.group.traverse((object) => {
    if (!object.isMesh || object.userData.skipTriangleCount) return;
    let parent = object;
    while (parent) {
      if (parent.visible === false) return;
      parent = parent.parent;
    }
    const geometry = object.geometry;
    if (!geometry) return;
    const count = geometry.index
      ? geometry.index.count
      : geometry.attributes.position?.count || 0;
    const drawRange = geometry.drawRange;
    if (drawRange && drawRange.count !== Infinity) {
      total += Math.max(0, Math.min(count, drawRange.count) / 3);
    } else {
      total += Math.max(0, count / 3);
    }
  });
  return Math.round(total);
}

function updateTriangleCount() {
  const count = countTriangles();
  $("#triangleCount").textContent = count
    ? `${new Intl.NumberFormat("en-US").format(count)} tris`
    : "— tris";
}

function exportViewport() {
  const width = Math.max(renderer.domElement.width, 1);
  const height = Math.max(renderer.domElement.height, 1);
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = width;
  exportCanvas.height = height;
  const context = exportCanvas.getContext("2d");
  const gradient = context.createRadialGradient(
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
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  if (state.view === "2d") {
    const scaleX = width / Math.max(plotCanvas.clientWidth, 1);
    const scaleY = height / Math.max(plotCanvas.clientHeight, 1);
    context.drawImage(plotCanvas, 0, 0, width, height);
    if (scaleX !== 1 || scaleY !== 1) {
      // drawImage already scales the bitmap to the export canvas
    }
  } else {
    renderer.render(scene, camera);
    context.drawImage(renderer.domElement, 0, 0);
  }

  const link = document.createElement("a");
  link.download = `revolve-lab-${state.view}-${Math.round(state.sweep)}deg.png`;
  link.href = exportCanvas.toDataURL("image/png");
  link.click();
  showToast("Viewport exported as PNG");
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {
      showToast("Fullscreen is not available in this browser");
    });
  } else {
    document.exitFullscreen?.();
  }
}

$("#exportBtn").addEventListener("click", exportViewport);
$("#fullscreenBtn").addEventListener("click", toggleFullscreen);

/* -------------------------------------------------------------------------- */
/* Panels, toast, keyboard                                                    */
/* -------------------------------------------------------------------------- */

$("#panelToggle").addEventListener("click", () => {
  const panel = $("#editorPanel");
  const open = panel.classList.toggle("open");
  $("#panelToggle").setAttribute("aria-expanded", String(open));
});

let toastTimer = 0;
function showToast(message, duration = 1800) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), duration);
}

window.addEventListener("keydown", (event) => {
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.metaKey || event.ctrlKey || event.altKey) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      exportViewport();
    }
    return;
  }

  switch (event.key.toLowerCase()) {
    case " ":
      event.preventDefault();
      if (state.view === "3d") setPlaying(!state.playing);
      break;
    case "f":
      if (state.view === "3d") {
        frameSolid({ animate: true });
        showToast("Framed the solid");
      }
      break;
    case "g":
      $("#gridBtn").click();
      break;
    case "w":
      $(`.shading-button[data-shading="wire"]`).click();
      break;
    case "x":
      $(`.shading-button[data-shading="xray"]`).click();
      break;
    case "r":
      if (state.view === "3d") {
        frameSolid({ animate: true });
        showToast("View reset");
      } else {
        plot.fit({ userAction: false });
      }
      break;
    case "1":
      setView("2d");
      break;
    case "2":
      if (!state.solid || state.stale) generateSolid();
      else setView("3d");
      break;
    case "escape":
      $("#editorPanel").classList.remove("open");
      $("#panelToggle").setAttribute("aria-expanded", "false");
      break;
    default:
      break;
  }
});

/* -------------------------------------------------------------------------- */
/* Resize, controls, boot                                                     */
/* -------------------------------------------------------------------------- */

function resize() {
  const width = Math.max(viewport.clientWidth, 1);
  const height = Math.max(viewport.clientHeight, 1);
  renderer.setPixelRatio(renderScale);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  state.solid?.setResolution(width, height);
  plot.resize();
  requestRender();
}

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(viewport);
window.addEventListener("resize", resize);

controls.addEventListener("start", () => {
  state.interacting = true;
  cancelCameraTween();
  state.playAfterCamera = false;
});
controls.addEventListener("end", () => {
  state.interacting = false;
});
controls.addEventListener("change", () => {
  requestRender();
});

renderer.domElement.addEventListener("contextmenu", (event) => event.preventDefault());

function hexToRgba(hex, alpha) {
  const normalized = String(hex).replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => character + character)
          .join("")
      : normalized.padEnd(6, "0");
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
}

function setCameraForModel(model) {
  if (!model?.ok) return;
  const xMid = (model.bounds.xMin + model.bounds.xMax) / 2;
  const yMid = (model.bounds.yMin + model.bounds.yMax) / 2;
  const span = Math.max(
    model.bounds.xMax - model.bounds.xMin,
    model.bounds.yMax - model.bounds.yMin,
    1,
  );
  controls.target.set(xMid, yMid, 0);
  camera.position.set(xMid + span * 1.2, yMid + span * 0.7, span * 1.8);
  camera.lookAt(controls.target);
}

function boot() {
  resize();
  buildLineRows();
  const model = analyzeNow({ fit: true });
  setCameraForModel(model);
  setView("2d", { stopPlayback: true });
  setSweep(360, { ui: true, quiet: true });
  $("#gridBtn").classList.add("active");
  $$(".view-tab").forEach((button) => {
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.view === "2d"),
    );
  });
  requestRender();
}

boot();
