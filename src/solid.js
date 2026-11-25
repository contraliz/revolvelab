import * as THREE from "three";
import {
  cellPolygonLocal,
  cellRadialIntervalAt,
  cellURangeFor,
} from "./region.js";

const TAU = Math.PI * 2;
const SEG_PHI = 192;
const SEG_U_BASE = 148;
const CAP_SEGMENTS = 192;

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

function radialAt(cell, axis, u) {
  return cellRadialIntervalAt(cell, axis, u);
}

function buildSurfaceGeometry(cell, axis, which) {
  const range = cellURangeFor(cell, axis);
  const span = Math.max(range.max - range.min, 1e-8);
  const segmentsU = Math.max(
    48,
    Math.min(230, Math.round(SEG_U_BASE + Math.abs(span) * 2)),
  );
  const startAngle =
    which === "outer" || which === "inner" ? cell.startAngle : 0;
  const positions = [];
  const indices = [];
  let previous = null;

  for (let j = 0; j <= SEG_PHI; j++) {
    const phi = startAngle + (j / SEG_PHI) * TAU;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    for (let i = 0; i <= segmentsU; i++) {
      const u = range.min + (span * i) / segmentsU;
      let radial = radialAt(cell, axis, u);
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

function buildCapGeometry(cell, axis, u, inner, outer, startAngle, outward) {
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

function buildCutGeometry(cell, axis) {
  const polygon = cellPolygonLocal(cell, axis);
  if (polygon.length < 3) return null;
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

function buildOutlineGeometry(cell, axis) {
  const polygon = cellPolygonLocal(cell, axis);
  if (polygon.length < 2) return null;
  const points = polygon.map(
    (point) => new THREE.Vector3(point.u, point.v, 0.002),
  );
  return new THREE.BufferGeometry().setFromPoints(points);
}

function determineStartAngle(cell, axis) {
  const range = cellURangeFor(cell, axis);
  const u = (range.min + range.max) / 2;
  const interval = radialAt(cell, axis, u);
  if (!interval) return 0;
  const polygon = cellPolygonLocal(cell, axis);
  let min = Infinity;
  let max = -Infinity;
  for (const point of polygon) {
    min = Math.min(min, point.v);
    max = Math.max(max, point.v);
  }
  const offset = 1e-7;
  if (max < -offset) return Math.PI;
  if (min > offset) return 0;
  return 0;
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

  const surfaces = [];
  const caps = [];
  const cutFaces = [];
  const outlines = [];
  let maxInner = 0;

  for (const cell of model.cells) {
    const range = cellURangeFor(cell, model.axis);
    const startAngle = determineStartAngle(cell, model.axis);
    cell.startAngle = startAngle;

    let cellMaxInner = 0;
    for (let sample = 1; sample < 12; sample++) {
      const u = range.min + ((range.max - range.min) * sample) / 12;
      const radial = radialAt(cell, model.axis, u);
      if (radial) cellMaxInner = Math.max(cellMaxInner, radial.inner);
    }
    maxInner = Math.max(maxInner, cellMaxInner);

    const outerGeometry = buildSurfaceGeometry(cell, model.axis, "outer");
    const outer = new THREE.Mesh(outerGeometry, outerMaterial);
    outer.renderOrder = 1;
    group.add(outer);
    surfaces.push({
      mesh: outer,
      geometry: outerGeometry,
      which: "outer",
      segmentsU: outerGeometry.userData.segmentsU,
    });

    if (cellMaxInner > 1e-5) {
      const innerGeometry = buildSurfaceGeometry(cell, model.axis, "inner");
      const inner = new THREE.Mesh(innerGeometry, innerMaterial);
      inner.renderOrder = 1;
      group.add(inner);
      surfaces.push({
        mesh: inner,
        geometry: innerGeometry,
        which: "inner",
        segmentsU: innerGeometry.userData.segmentsU,
      });
    }

    const endSamples = [
      range.min,
      range.max,
    ];
    for (const [index, u] of endSamples.entries()) {
      const radial = radialAt(cell, model.axis, u);
      if (!radial || radial.outer < 1e-5) continue;
      const geometry = buildCapGeometry(
        cell,
        model.axis,
        u,
        radial.inner,
        radial.outer,
        startAngle,
        index === 0 ? -1 : 1,
      );
      const cap = new THREE.Mesh(geometry, capMaterial);
      cap.renderOrder = 1;
      group.add(cap);
      caps.push({ mesh: cap, geometry });
    }

    const cutGeometry = buildCutGeometry(cell, model.axis);
    if (cutGeometry) {
      const cutStart = new THREE.Mesh(cutGeometry, cutMaterial);
      const cutEnd = new THREE.Mesh(cutGeometry, cutMaterial);
      cutStart.renderOrder = 2;
      cutEnd.renderOrder = 2;
      group.add(cutStart, cutEnd);
      cutFaces.push({ start: cutStart, end: cutEnd });

      const outlineGeometry = buildOutlineGeometry(cell, model.axis);
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
        outlines.push({ start: startOutline, end: endOutline });
      }
    }
  }

  let currentMode = "solid";
  let lastSweep = 0;

  function syncCutVisibility() {
    const partial = lastSweep < TAU - 0.002;
    const beginning = lastSweep >= 0;
    const visible = currentMode !== "wire";
    for (const face of cutFaces) {
      face.start.visible = partial && beginning && visible;
      face.end.visible = partial && lastSweep > 0.004 && visible;
    }
    for (const outline of outlines) {
      outline.start.visible = partial && beginning;
      outline.end.visible = partial && lastSweep > 0.004;
    }
  }

  function applyMode(mode) {
    if (!["solid", "xray", "wire"].includes(mode)) return;
    currentMode = mode;
    const xray = mode === "xray";
    const wire = mode === "wire";

    outerMaterial.wireframe = wire;
    innerMaterial.wireframe = wire;
    outerMaterial.transparent = mode !== "solid";
    innerMaterial.transparent = mode !== "solid";
    outerMaterial.depthWrite = mode === "solid";
    innerMaterial.depthWrite = mode === "solid";
    outerMaterial.opacity = xray ? 0.16 : wire ? 0.14 : 0.98;
    innerMaterial.opacity = xray ? 0.12 : wire ? 0.1 : 0.98;
    outerMaterial.needsUpdate = true;
    innerMaterial.needsUpdate = true;

    capMaterial.transparent = mode !== "solid";
    capMaterial.depthWrite = mode === "solid";
    capMaterial.opacity = xray ? 0.14 : wire ? 0.04 : 0.98;
    capMaterial.wireframe = wire;
    capMaterial.needsUpdate = true;

    cutMaterial.opacity = xray ? 0.42 : 0.82;
    cutMaterial.needsUpdate = true;

    for (const cap of caps) cap.mesh.visible = !wire;
    syncCutVisibility();
  }

  function updateSweep(sweepRadians) {
    const sweep = THREE.MathUtils.clamp(sweepRadians, 0, TAU);
    const fraction = sweep / TAU;
    const usedSegments = Math.min(
      SEG_PHI,
      Math.ceil(fraction * SEG_PHI),
    );

    for (const surface of surfaces) {
      const count = usedSegments * surface.segmentsU * 6;
      surface.geometry.setDrawRange(0, count);
      surface.mesh.visible = count > 0;
    }

    for (const cap of caps) {
      const capCount =
        usedSegments * (cap.geometry.userData.indicesPerSegment || 6);
      cap.geometry.setDrawRange(0, capCount);
      cap.mesh.visible = capCount > 0 && currentMode !== "wire";
    }

    for (const face of cutFaces) {
      face.end.rotation.x = sweep;
    }
    for (const outline of outlines) {
      outline.end.rotation.x = sweep;
    }

    lastSweep = sweep;
    syncCutVisibility();
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
