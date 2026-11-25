import * as THREE from "three";
import {
  cellRadialIntervalAt,
  cellSideRadialIntervalAt,
  cellURangeFor,
} from "./region.js";

const TAU = Math.PI * 2;
const SEG_PHI = 192;
const SEG_U_BASE = 148;
const CAP_SEGMENTS = 192;
const CONTOUR_MERIDIANS = 12;
const CONTOUR_RINGS = 9;
const CONTOUR_SEGMENTS = 96;
const EPS = 1e-6;

function basisForAxis(axis) {
  const direction = new THREE.Vector3(
    axis.direction.x,
    axis.direction.y,
    0,
  );
  const normal = new THREE.Vector3(axis.normal.x, axis.normal.y, 0);
  const z = new THREE.Vector3(0, 0, 1);
  const matrix = new THREE.Matrix4().makeBasis(direction, normal, z);
  matrix.setPosition(axis.point.x, axis.point.y, 0);
  return matrix;
}

function segmentsForRange(range) {
  const span = Math.max(range.max - range.min, 1e-8);
  return Math.max(
    48,
    Math.min(230, Math.round(SEG_U_BASE + Math.abs(span) * 2)),
  );
}

function radialAt(cell, axis, u) {
  return cellRadialIntervalAt(cell, axis, u);
}

function sideRadialAt(cell, axis, u, sign) {
  return cellSideRadialIntervalAt(cell, axis, u, sign);
}

function buildSurfaceGeometry(radialFn, range, startAngle, which) {
  const span = Math.max(range.max - range.min, 1e-8);
  const segmentsU = segmentsForRange(range);
  const positions = [];
  const indices = [];
  let previous = null;

  for (let j = 0; j <= SEG_PHI; j++) {
    const phi = startAngle + (j / SEG_PHI) * TAU;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    for (let i = 0; i <= segmentsU; i++) {
      const u = range.min + (span * i) / segmentsU;
      let radial = radialFn(u);
      if (!radial) {
        radial =
          i === 0 || i === segmentsU
            ? { inner: 0, outer: 0 }
            : previous || { inner: 0, outer: 0 };
      }
      previous = radial;
      const rawRadius = which === "outer" ? radial.outer : radial.inner;
      const radius = rawRadius < 1e-5 ? 0 : rawRadius;
      positions.push(u, radius * cos, radius * sin);
    }
  }

  const row = segmentsU + 1;
  for (let j = 0; j < SEG_PHI; j++) {
    for (let i = 0; i < segmentsU; i++) {
      const a = j * row + i;
      const b = (j + 1) * row + i;
      const c = a + 1;
      const d = b + 1;
      if (which === "outer") {
        indices.push(a, b, c, b, d, c);
      } else {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.setDrawRange(0, 0);
  geometry.userData.segmentsU = segmentsU;
  return geometry;
}

function buildCapGeometry(u, inner, outer, startAngle, outward) {
  const positions = [];
  const normals = [];
  const indices = [];
  const hasHole = inner > 1e-5;

  if (!hasHole) {
    positions.push(u, 0, 0);
    normals.push(outward, 0, 0);
  }

  for (let j = 0; j <= CAP_SEGMENTS; j++) {
    const phi = startAngle + (j / CAP_SEGMENTS) * TAU;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    if (hasHole) {
      positions.push(u, inner * cos, inner * sin);
      normals.push(outward, 0, 0);
    }
    positions.push(u, outer * cos, outer * sin);
    normals.push(outward, 0, 0);
  }

  if (hasHole) {
    const row = 2;
    for (let j = 0; j < CAP_SEGMENTS; j++) {
      const a = j * row;
      const b = (j + 1) * row;
      const c = a + 1;
      const d = b + 1;
      if (outward > 0) {
        indices.push(a, b, c, b, d, c);
      } else {
        indices.push(a, c, b, b, c, d);
      }
    }
  } else {
    for (let j = 0; j < CAP_SEGMENTS; j++) {
      const center = 0;
      const a = 1 + j;
      const b = 1 + j + 1;
      if (outward > 0) {
        indices.push(center, a, b);
      } else {
        indices.push(center, b, a);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.setDrawRange(0, 0);
  geometry.userData.indicesPerSegment = hasHole ? 6 : 3;
  return geometry;
}

function buildPolygonGeometry(polygon) {
  if (!polygon || polygon.length < 3) return null;
  const shape = new THREE.Shape();
  shape.moveTo(polygon[0].u, polygon[0].v);
  for (let index = 1; index < polygon.length; index++) {
    shape.lineTo(polygon[index].u, polygon[index].v);
  }
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.computeBoundingSphere();
  return geometry;
}

function buildOutlineGeometry(polygon) {
  if (!polygon || polygon.length < 2) return null;
  return new THREE.BufferGeometry().setFromPoints(
    polygon.map((point) => new THREE.Vector3(point.u, point.v, 0.002)),
  );
}

function radialRangeForSide(cell, axis, sign, fullRange) {
  const samples = 80;
  const step = (fullRange.max - fullRange.min) / samples;
  const present = new Array(samples + 1).fill(false);
  for (let index = 0; index <= samples; index++) {
    const u = fullRange.min + step * index;
    present[index] = Boolean(sideRadialAt(cell, axis, u, sign));
  }
  const first = present.indexOf(true);
  if (first < 0) return null;
  let last = samples;
  while (last > 0 && !present[last]) last -= 1;
  if (last <= first) return null;

  let min = fullRange.min + step * first;
  if (first > 0) {
    let outside = min - step;
    let inside = min;
    for (let iteration = 0; iteration < 48; iteration++) {
      const middle = (outside + inside) / 2;
      if (sideRadialAt(cell, axis, middle, sign)) {
        inside = middle;
      } else {
        outside = middle;
      }
    }
    min = inside;
  }

  let max = fullRange.min + step * last;
  if (last < samples) {
    let inside = max;
    let outside = max + step;
    for (let iteration = 0; iteration < 48; iteration++) {
      const middle = (inside + outside) / 2;
      if (sideRadialAt(cell, axis, middle, sign)) {
        inside = middle;
      } else {
        outside = middle;
      }
    }
    max = inside;
  }

  if (max - min < 1e-7) return null;
  return { min, max };
}

function maxInnerForSide(radialFn, range) {
  let maxInner = 0;
  for (let sample = 1; sample < 16; sample++) {
    const u = range.min + ((range.max - range.min) * sample) / 16;
    const radial = radialFn(u);
    if (radial) maxInner = Math.max(maxInner, radial.inner);
  }
  return maxInner;
}

function buildSidePolygon(radialFn, range, sign) {
  const samples = 140;
  const outer = [];
  const inner = [];
  let previous = null;

  for (let index = 0; index <= samples; index++) {
    const u = range.min + ((range.max - range.min) * index) / samples;
    let radial = radialFn(u);
    if (!radial) {
      radial =
        index === 0 || index === samples
          ? { inner: 0, outer: 0 }
          : previous || { inner: 0, outer: 0 };
    }
    previous = radial;
    const outerRadius = radial.outer < 1e-5 ? 0 : radial.outer;
    const innerRadius = radial.inner < 1e-5 ? 0 : radial.inner;
    outer.push({ u, v: sign * outerRadius });
    inner.push({ u, v: sign * innerRadius });
  }

  return [...outer, ...inner.reverse()];
}

function buildContours(radialFn, range, startAngle, createLine) {
  const lines = [];
  const span = Math.max(range.max - range.min, 1e-8);
  let hasInner = false;
  for (let sample = 1; sample < 12; sample++) {
    const u = range.min + (span * sample) / 12;
    const radial = radialFn(u);
    if (radial && radial.inner > 1e-5) {
      hasInner = true;
      break;
    }
  }

  for (let index = 0; index < CONTOUR_MERIDIANS; index++) {
    const relative = (index / CONTOUR_MERIDIANS) * TAU;
    const phi = startAngle + relative;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const outerPoints = [];
    const innerPoints = [];
    for (let step = 0; step <= 72; step++) {
      const u = range.min + (span * step) / 72;
      const radial = radialFn(u);
      if (!radial) continue;
      const outer = radial.outer < 1e-5 ? 0 : radial.outer;
      const inner = radial.inner < 1e-5 ? 0 : radial.inner;
      outerPoints.push(new THREE.Vector3(u, outer * cos, outer * sin));
      if (hasInner) {
        innerPoints.push(new THREE.Vector3(u, inner * cos, inner * sin));
      }
    }
    if (outerPoints.length > 1) {
      lines.push(
        createLine(
          new THREE.BufferGeometry().setFromPoints(outerPoints),
          "meridian",
          relative,
        ),
      );
      if (hasInner) {
        lines.push(
          createLine(
            new THREE.BufferGeometry().setFromPoints(innerPoints),
            "meridian",
            relative,
          ),
        );
      }
    }
  }

  for (let index = 0; index < CONTOUR_RINGS; index++) {
    const u =
      range.min + (0.055 + (index / (CONTOUR_RINGS - 1)) * 0.89) * span;
    const radial = radialFn(u);
    if (!radial || radial.outer < 1e-5) continue;
    const outerPoints = [];
    const innerPoints = [];
    for (let step = 0; step <= CONTOUR_SEGMENTS; step++) {
      const phi = startAngle + (step / CONTOUR_SEGMENTS) * TAU;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      outerPoints.push(
        new THREE.Vector3(u, radial.outer * cos, radial.outer * sin),
      );
      if (hasInner && radial.inner > 1e-5) {
        innerPoints.push(
          new THREE.Vector3(u, radial.inner * cos, radial.inner * sin),
        );
      }
    }
    const outerLine = createLine(
      new THREE.BufferGeometry().setFromPoints(outerPoints),
      "ring",
      0,
    );
    outerLine.userData.segments = CONTOUR_SEGMENTS;
    lines.push(outerLine);
    if (innerPoints.length > 1) {
      const innerLine = createLine(
        new THREE.BufferGeometry().setFromPoints(innerPoints),
        "ring",
        0,
      );
      innerLine.userData.segments = CONTOUR_SEGMENTS;
      lines.push(innerLine);
    }
  }

  return lines;
}

export function createRevolvedSolid(model) {
  const group = new THREE.Group();
  group.name = "Solid of revolution";
  group.matrixAutoUpdate = false;
  group.matrix.copy(basisForAxis(model.axis));

  const outerMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x0d8f83,
    metalness: 0.14,
    roughness: 0.3,
    clearcoat: 0.42,
    clearcoatRoughness: 0.22,
    transparent: true,
    opacity: 0.98,
    side: THREE.DoubleSide,
    envMapIntensity: 0.58,
  });

  const innerMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x064747,
    metalness: 0.18,
    roughness: 0.4,
    clearcoat: 0.18,
    clearcoatRoughness: 0.3,
    transparent: true,
    opacity: 0.98,
    side: THREE.DoubleSide,
    envMapIntensity: 0.44,
  });

  const capMaterial = new THREE.MeshBasicMaterial({
    color: 0x0a5a56,
    transparent: true,
    opacity: 0.98,
    side: THREE.DoubleSide,
    depthWrite: true,
    toneMapped: false,
  });

  const cutMaterial = new THREE.MeshBasicMaterial({
    color: 0xf2833f,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });

  const outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xffb26f,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
  });

  const contourMaterial = new THREE.LineBasicMaterial({
    color: 0x8cebdc,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  });

  const surfaces = [];
  const caps = [];
  const cutFaces = [];
  const outlines = [];
  const contours = [];
  let maxInner = 0;

  function addContours(radialFn, range, startAngle, rep, hideWhenFull) {
    const created = buildContours(
      radialFn,
      range,
      startAngle,
      (geometry, kind, relativeAngle) => {
        const line = new THREE.Line(geometry, contourMaterial);
        line.userData.kind = kind;
        line.userData.relativeAngle = relativeAngle;
        line.userData.rep = rep;
        line.userData.hideWhenFull = hideWhenFull;
        line.renderOrder = 1;
        group.add(line);
        return line;
      },
    );
    for (const line of created) {
      contours.push(line);
    }
  }

  function addCap(u, radial, startAngle, outward, rep, hideWhenFull) {
    if (!radial || radial.outer < 1e-5) return;
    const geometry = buildCapGeometry(
      u,
      radial.inner,
      radial.outer,
      startAngle,
      outward,
    );
    const mesh = new THREE.Mesh(geometry, capMaterial);
    mesh.renderOrder = 1;
    group.add(mesh);
    caps.push({ mesh, geometry, rep, hideWhenFull });
  }

  function addTube(radialFn, range, startAngle, rep, hideWhenFull, options = {}) {
    const { cuts = true, caps: includeCaps = true } = options;
    const outerGeometry = buildSurfaceGeometry(
      radialFn,
      range,
      startAngle,
      "outer",
    );
    const outer = new THREE.Mesh(outerGeometry, outerMaterial);
    outer.renderOrder = 1;
    group.add(outer);
    surfaces.push({
      mesh: outer,
      geometry: outerGeometry,
      segmentsU: outerGeometry.userData.segmentsU,
      rep,
      hideWhenFull,
    });

    const maxInnerSide = maxInnerForSide(radialFn, range);
    maxInner = Math.max(maxInner, maxInnerSide);
    if (maxInnerSide > 1e-5) {
      const innerGeometry = buildSurfaceGeometry(
        radialFn,
        range,
        startAngle,
        "inner",
      );
      const inner = new THREE.Mesh(innerGeometry, innerMaterial);
      inner.renderOrder = 1;
      group.add(inner);
      surfaces.push({
        mesh: inner,
        geometry: innerGeometry,
        segmentsU: innerGeometry.userData.segmentsU,
        rep,
        hideWhenFull,
      });
    }

    if (includeCaps) {
      addCap(
        range.min,
        radialFn(range.min),
        startAngle,
        -1,
        rep,
        hideWhenFull,
      );
      addCap(
        range.max,
        radialFn(range.max),
        startAngle,
        1,
        rep,
        hideWhenFull,
      );
    }

    if (cuts) {
      const polygon = buildSidePolygon(radialFn, range, startAngle === 0 ? 1 : -1);
      const cutGeometry = buildPolygonGeometry(polygon);
      if (cutGeometry) {
        const cutStart = new THREE.Mesh(cutGeometry, cutMaterial);
        const cutEnd = new THREE.Mesh(cutGeometry, cutMaterial);
        cutStart.renderOrder = 2;
        cutEnd.renderOrder = 2;
        group.add(cutStart, cutEnd);
        cutFaces.push({ start: cutStart, end: cutEnd, rep, hideWhenFull });

        const outlineGeometry = buildOutlineGeometry(polygon);
        if (outlineGeometry) {
          const startOutline = new THREE.LineLoop(
            outlineGeometry,
            outlineMaterial,
          );
          const endOutline = new THREE.LineLoop(
            outlineGeometry,
            outlineMaterial.clone(),
          );
          startOutline.renderOrder = 3;
          endOutline.renderOrder = 3;
          group.add(startOutline, endOutline);
          outlines.push({ start: startOutline, end: endOutline, rep, hideWhenFull });
        }
      }
    }

    addContours(radialFn, range, startAngle, rep, hideWhenFull);
  }

  for (const cell of model.cells) {
    const fullRange = cellURangeFor(cell, model.axis);
    const positiveRange = radialRangeForSide(cell, model.axis, 1, fullRange);
    const negativeRange = radialRangeForSide(cell, model.axis, -1, fullRange);
    const crossing = Boolean(positiveRange && negativeRange);

    if (crossing) {
      // A full revolution of a region that crosses the axis is a single radial
      // band. Keep that clean union for 360°, and signed half-shells for the
      // cutaway so both sides of the source region line up with their cut faces.
      addTube(
        (u) => radialAt(cell, model.axis, u),
        fullRange,
        0,
        "union",
        false,
        { cuts: false },
      );
    }

    if (positiveRange) {
      addTube(
        (u) => sideRadialAt(cell, model.axis, u, 1),
        positiveRange,
        0,
        "side",
        crossing,
      );
    }
    if (negativeRange) {
      addTube(
        (u) => sideRadialAt(cell, model.axis, u, -1),
        negativeRange,
        Math.PI,
        "side",
        crossing,
      );
    }
  }

  let currentMode = "solid";
  let lastSweep = 0;

  function syncVisibility() {
    const full = lastSweep >= TAU - 0.002;
    const wire = currentMode === "wire";
    const usedSegments = Math.min(
      SEG_PHI,
      Math.ceil((lastSweep / TAU) * SEG_PHI),
    );

    for (const surface of surfaces) {
      const hiddenByRepresentation =
        (surface.rep === "union" && !full) ||
        (surface.hideWhenFull && full);
      if (wire || hiddenByRepresentation) {
        surface.mesh.visible = false;
        continue;
      }
      const count = usedSegments * surface.segmentsU * 6;
      surface.geometry.setDrawRange(0, count);
      surface.mesh.visible = count > 0;
    }

    for (const cap of caps) {
      const hiddenByRepresentation =
        (cap.rep === "union" && !full) || (cap.hideWhenFull && full);
      if (wire || hiddenByRepresentation) {
        cap.mesh.visible = false;
        continue;
      }
      const count =
        usedSegments * (cap.geometry.userData.indicesPerSegment || 6);
      cap.geometry.setDrawRange(0, count);
      cap.mesh.visible = count > 0;
    }

    const partial = !full;
    for (const face of cutFaces) {
      const hiddenByRepresentation =
        (face.rep === "union" && !full) || (face.hideWhenFull && full);
      face.start.visible = partial && !hiddenByRepresentation && !wire;
      face.end.visible =
        partial && lastSweep > 0.004 && !hiddenByRepresentation && !wire;
      face.end.rotation.x = lastSweep;
    }

    for (const outline of outlines) {
      const hiddenByRepresentation =
        (outline.rep === "union" && !full) || (outline.hideWhenFull && full);
      outline.start.visible = partial && !hiddenByRepresentation;
      outline.end.visible =
        partial && lastSweep > 0.004 && !hiddenByRepresentation;
      outline.end.rotation.x = lastSweep;
    }

    for (const line of contours) {
      const hiddenByRepresentation =
        (line.userData.rep === "union" && !full) ||
        (line.userData.hideWhenFull && full);
      if (hiddenByRepresentation) {
        line.visible = false;
        continue;
      }
      if (line.userData.kind === "ring") {
        const segments = line.userData.segments || CONTOUR_SEGMENTS;
        const count =
          1 + Math.min(segments, Math.ceil((lastSweep / TAU) * segments));
        line.geometry.setDrawRange(0, count);
        line.visible = count > 1;
      } else {
        line.visible =
          lastSweep > 0.002 &&
          line.userData.relativeAngle <= lastSweep + 0.002;
      }
    }
  }

  function applyMode(mode) {
    if (!["solid", "xray", "wire"].includes(mode)) return;
    currentMode = mode;
    const xray = mode === "xray";
    const wire = mode === "wire";

    outerMaterial.wireframe = false;
    innerMaterial.wireframe = false;
    capMaterial.wireframe = false;
    outerMaterial.transparent = mode !== "solid";
    innerMaterial.transparent = mode !== "solid";
    outerMaterial.depthWrite = mode === "solid";
    innerMaterial.depthWrite = mode === "solid";
    outerMaterial.opacity = xray ? 0.16 : 0.98;
    innerMaterial.opacity = xray ? 0.12 : 0.98;
    outerMaterial.needsUpdate = true;
    innerMaterial.needsUpdate = true;

    capMaterial.transparent = mode !== "solid";
    capMaterial.depthWrite = mode === "solid";
    capMaterial.opacity = xray ? 0.14 : 0.98;
    capMaterial.needsUpdate = true;

    cutMaterial.opacity = xray ? 0.42 : 0.82;
    cutMaterial.needsUpdate = true;

    if (wire) {
      contourMaterial.color.setHex(0x9af4e4);
      contourMaterial.opacity = 0.52;
    } else if (xray) {
      contourMaterial.color.setHex(0xa4fff0);
      contourMaterial.opacity = 0.28;
    } else {
      contourMaterial.color.setHex(0x8cebdc);
      contourMaterial.opacity = 0.15;
    }
    contourMaterial.needsUpdate = true;

    syncVisibility();
  }

  function updateSweep(sweepRadians) {
    lastSweep = THREE.MathUtils.clamp(sweepRadians, 0, TAU);
    syncVisibility();
  }

  applyMode("solid");
  updateSweep(0);

  return {
    group,
    updateSweep,
    applyMode,
    getSweep: () => lastSweep,
    getMode: () => currentMode,
    maxInner,
    materials: {
      outerMaterial,
      innerMaterial,
      capMaterial,
      cutMaterial,
      outlineMaterial,
      contourMaterial,
    },
  };
}

export function disposeRevolvedSolid(solid) {
  if (!solid?.group) return;
  const materials = new Set();
  solid.group.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => materials.add(material));
    } else if (object.material) {
      materials.add(object.material);
    }
  });
  materials.forEach((material) => material.dispose());
}
