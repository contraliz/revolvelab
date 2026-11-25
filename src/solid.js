import * as THREE from "three";
import { TAU } from "./data.js";

const SEG_X = 128;
const SEG_PHI = 288;
const CUT_X = 88;
const CUT_R = 20;
const CAP_R = 18;
const RING_COUNT = 11;
const MERIDIAN_COUNT = 16;

function domainOf(problem) {
  const x0 = Number(problem.domain?.x0 ?? 0);
  const x1 = Number(problem.domain?.x1 ?? 4);
  return { x0, x1, span: x1 - x0, mid: (x0 + x1) / 2 };
}

function buildProfileSurface(problem, which, domain) {
  const isOuter = which === "outer";
  const radiusAt = isOuter ? problem.outer : problem.inner;
  const slopeAt = isOuter
    ? problem.outerDerivative
    : problem.innerDerivative;
  const start = problem.startAngle;

  const positions = [];
  const normals = [];
  const indices = [];

  for (let j = 0; j <= SEG_PHI; j++) {
    const phi = start + (j / SEG_PHI) * TAU;
    const c = Math.cos(phi);
    const s = Math.sin(phi);

    for (let i = 0; i <= SEG_X; i++) {
      const x = domain.x0 + (i / SEG_X) * domain.span;
      const r = radiusAt(x);
      const slope = slopeAt(x);
      positions.push(x, r * c, r * s);

      let nx;
      let ny;
      let nz;
      if (isOuter) {
        nx = -slope;
        ny = c;
        nz = s;
      } else {
        nx = slope;
        ny = -c;
        nz = -s;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / len, ny / len, nz / len);
    }
  }

  const row = SEG_X + 1;
  for (let j = 0; j < SEG_PHI; j++) {
    for (let i = 0; i < SEG_X; i++) {
      const a = j * row + i;
      const b = (j + 1) * row + i;
      const c = a + 1;
      const d = b + 1;

      if (isOuter) {
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
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(domain.mid, 0, 0),
    Math.hypot(domain.span / 2, problem.maxRadius) + 0.2,
  );
  geometry.setDrawRange(0, 0);
  return geometry;
}

function buildCutFace(problem, domain) {
  const positions = [];
  const indices = [];

  for (let i = 0; i <= CUT_X; i++) {
    const x = domain.x0 + (i / CUT_X) * domain.span;
    const ri = problem.inner(x);
    const ro = problem.outer(x);
    for (let k = 0; k <= CUT_R; k++) {
      const r = ri + (k / CUT_R) * (ro - ri);
      positions.push(x, r, 0);
    }
  }

  const row = CUT_R + 1;
  for (let i = 0; i < CUT_X; i++) {
    for (let k = 0; k < CUT_R; k++) {
      const a = i * row + k;
      const b = (i + 1) * row + k;
      const c = a + 1;
      const d = b + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildOutline(problem, domain) {
  const points = [];
  const n = 100;

  for (let i = 0; i <= n; i++) {
    const x = domain.x0 + (i / n) * domain.span;
    points.push(new THREE.Vector3(x, problem.outer(x), 0.001));
  }
  for (let i = 1; i <= 22; i++) {
    const r =
      problem.outer(domain.x1) +
      (problem.inner(domain.x1) - problem.outer(domain.x1)) * (i / 22);
    points.push(new THREE.Vector3(domain.x1, r, 0.001));
  }
  for (let i = n - 1; i >= 0; i--) {
    const x = domain.x0 + (i / n) * domain.span;
    points.push(new THREE.Vector3(x, problem.inner(x), 0.001));
  }
  for (let i = 1; i < 22; i++) {
    const r =
      problem.inner(domain.x0) +
      (problem.outer(domain.x0) - problem.inner(domain.x0)) * (i / 22);
    points.push(new THREE.Vector3(domain.x0, r, 0.001));
  }

  return new THREE.BufferGeometry().setFromPoints(points);
}

function buildMeridianGeometry(problem, radiusAt, phi, domain) {
  const points = [];
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  for (let i = 0; i <= 120; i++) {
    const x = domain.x0 + (i / 120) * domain.span;
    const r = radiusAt(x);
    points.push(new THREE.Vector3(x, r * c, r * s));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function buildRingGeometry(problem, radiusAt, x) {
  const points = [];
  const r = radiusAt(x) + 0.002;
  for (let j = 0; j <= SEG_PHI; j++) {
    const phi = problem.startAngle + (j / SEG_PHI) * TAU;
    points.push(
      new THREE.Vector3(x, r * Math.cos(phi), r * Math.sin(phi)),
    );
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function buildEndCap(problem, x, outwardSign) {
  const innerRadius = problem.inner(x);
  const outerRadius = problem.outer(x);
  if (outerRadius - innerRadius < 1e-5) return null;

  const positions = [];
  const normals = [];
  const indices = [];

  for (let j = 0; j <= SEG_PHI; j++) {
    const phi = problem.startAngle + (j / SEG_PHI) * TAU;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k <= CAP_R; k++) {
      const radius =
        innerRadius + (k / CAP_R) * (outerRadius - innerRadius);
      positions.push(x, radius * c, radius * s);
      normals.push(outwardSign, 0, 0);
    }
  }

  const row = CAP_R + 1;
  for (let j = 0; j < SEG_PHI; j++) {
    for (let k = 0; k < CAP_R; k++) {
      const a = j * row + k;
      const b = (j + 1) * row + k;
      const c = a + 1;
      const d = b + 1;
      if (outwardSign > 0) {
        indices.push(a, c, b, b, c, d);
      } else {
        indices.push(a, b, c, b, d, c);
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
  geometry.setDrawRange(0, 0);
  return geometry;
}

export function createRevolvedSolid(problem) {
  const domain = domainOf(problem);
  const group = new THREE.Group();
  group.name = `Revolved solid — ${problem.axisFormula}`;
  group.position.y = problem.axisValue;

  const outerMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x0d8f83,
    metalness: 0.14,
    roughness: 0.32,
    clearcoat: 0.4,
    clearcoatRoughness: 0.22,
    transparent: true,
    opacity: 0.98,
    side: THREE.FrontSide,
    envMapIntensity: 0.55,
  });

  const innerMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x074d4d,
    metalness: 0.18,
    roughness: 0.42,
    clearcoat: 0.18,
    clearcoatRoughness: 0.3,
    transparent: true,
    opacity: 0.98,
    side: THREE.FrontSide,
    envMapIntensity: 0.45,
  });

  const cutMaterial = new THREE.MeshBasicMaterial({
    color: 0xf2833f,
    transparent: true,
    opacity: 0.84,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });

  const capMaterial = new THREE.MeshBasicMaterial({
    color: 0x0b5955,
    transparent: true,
    opacity: 0.98,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const outer = new THREE.Mesh(
    buildProfileSurface(problem, "outer", domain),
    outerMaterial,
  );
  const inner = new THREE.Mesh(
    buildProfileSurface(problem, "inner", domain),
    innerMaterial,
  );
  outer.castShadow = true;
  outer.receiveShadow = true;
  inner.receiveShadow = true;

  const capLowGeometry = buildEndCap(problem, domain.x0, -1);
  const capHighGeometry = buildEndCap(problem, domain.x1, 1);
  const capLow = capLowGeometry
    ? new THREE.Mesh(capLowGeometry, capMaterial)
    : null;
  const capHigh = capHighGeometry
    ? new THREE.Mesh(capHighGeometry, capMaterial)
    : null;
  if (capLow) capLow.receiveShadow = true;
  if (capHigh) capHigh.receiveShadow = true;

  const cutGeometry = buildCutFace(problem, domain);
  const cutStart = new THREE.Mesh(cutGeometry, cutMaterial);
  const cutEnd = new THREE.Mesh(cutGeometry, cutMaterial.clone());
  cutStart.rotation.x = problem.startAngle;
  cutEnd.rotation.x = problem.startAngle;
  cutStart.renderOrder = 2;
  cutEnd.renderOrder = 2;

  const outlineGeometry = buildOutline(problem, domain);
  const outlineMaterial = new THREE.LineBasicMaterial({
    color: 0xffb26f,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  const outlineStart = new THREE.LineLoop(outlineGeometry, outlineMaterial);
  const outlineEnd = new THREE.LineLoop(
    outlineGeometry,
    outlineMaterial.clone(),
  );
  outlineStart.rotation.x = problem.startAngle;
  outlineEnd.rotation.x = problem.startAngle;
  outlineStart.renderOrder = 3;
  outlineEnd.renderOrder = 3;

  const contourMaterial = new THREE.LineBasicMaterial({
    color: 0x082f31,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  const contourGroup = new THREE.Group();
  const meridianLines = [];
  const ringLines = [];

  for (let m = 0; m < MERIDIAN_COUNT; m++) {
    const relative = (m / MERIDIAN_COUNT) * TAU;
    const phi = problem.startAngle + relative;
    const line = new THREE.Line(
      buildMeridianGeometry(problem, problem.outer, phi, domain),
      contourMaterial,
    );
    line.userData.relativeAngle = relative;
    line.renderOrder = 1;
    meridianLines.push(line);
    contourGroup.add(line);

    if (problem.inner(domain.mid) > 0.01) {
      const innerLine = new THREE.Line(
        buildMeridianGeometry(problem, problem.inner, phi, domain),
        contourMaterial,
      );
      innerLine.userData.relativeAngle = relative;
      innerLine.renderOrder = 1;
      meridianLines.push(innerLine);
      contourGroup.add(innerLine);
    }
  }

  for (let k = 0; k < RING_COUNT; k++) {
    const x = domain.x0 + (0.055 + (k / (RING_COUNT - 1)) * 0.89) * domain.span;
    const outerRing = new THREE.Line(
      buildRingGeometry(problem, problem.outer, x),
      contourMaterial,
    );
    outerRing.userData.ring = true;
    outerRing.renderOrder = 1;
    ringLines.push(outerRing);
    contourGroup.add(outerRing);

    if (problem.inner(domain.mid) > 0.01) {
      const innerRing = new THREE.Line(
        buildRingGeometry(problem, problem.inner, x),
        contourMaterial,
      );
      innerRing.userData.ring = true;
      innerRing.renderOrder = 1;
      ringLines.push(innerRing);
      contourGroup.add(innerRing);
    }
  }

  group.add(outer, inner);
  if (capLow) group.add(capLow);
  if (capHigh) group.add(capHigh);
  group.add(cutStart, cutEnd, outlineStart, outlineEnd, contourGroup);
  group.userData.solid = true;

  let currentMode = "solid";
  let lastSweep = 0;
  let lastCutStart = true;
  let lastCutEnd = true;

  function syncCutState() {
    const overFull = lastSweep > TAU - 0.0025;
    const startVisible = !overFull && lastCutStart !== false;
    const endVisible = !overFull && lastSweep > 0.004 && lastCutEnd !== false;
    const fillVisible = currentMode !== "wire";

    cutStart.visible = startVisible && fillVisible;
    cutEnd.visible = endVisible && fillVisible;
    outlineStart.visible =
      startVisible && outlineStart.userData.wanted !== false;
    outlineEnd.visible = endVisible && outlineEnd.userData.wanted !== false;
  }

  function applyMode(mode) {
    currentMode = mode;
    const ghosted = mode === "ghost";
    const xray = mode === "xray";
    const wire = mode === "wire";

    outer.visible = true;
    inner.visible = true;
    outerMaterial.transparent = mode !== "solid";
    innerMaterial.transparent = mode !== "solid";
    outerMaterial.depthWrite = mode === "solid";
    innerMaterial.depthWrite = mode === "solid";
    outerMaterial.opacity = ghosted ? 0.075 : xray ? 0.16 : wire ? 0.035 : 0.98;
    innerMaterial.opacity = ghosted ? 0.05 : xray ? 0.12 : wire ? 0.025 : 0.98;
    outerMaterial.needsUpdate = true;
    innerMaterial.needsUpdate = true;

    cutMaterial.opacity = ghosted ? 0.16 : xray ? 0.44 : 0.84;
    cutStart.material.opacity = cutMaterial.opacity;
    cutEnd.material.opacity = cutMaterial.opacity;
    cutMaterial.needsUpdate = true;

    capMaterial.transparent = mode !== "solid";
    capMaterial.depthWrite = mode === "solid";
    capMaterial.opacity = ghosted ? 0.06 : xray ? 0.14 : wire ? 0.025 : 0.98;
    capMaterial.needsUpdate = true;
    if (capLow) capLow.visible = !wire;
    if (capHigh) capHigh.visible = !wire;

    syncCutState();

    if (wire) {
      contourMaterial.color.setHex(0x92f8e6);
      contourMaterial.opacity = 0.52;
    } else if (xray || ghosted) {
      contourMaterial.color.setHex(0xa4fff0);
      contourMaterial.opacity = ghosted ? 0.16 : 0.34;
    } else {
      contourMaterial.color.setHex(0x052f31);
      contourMaterial.opacity = 0.2;
    }
    contourMaterial.needsUpdate = true;
  }

  function updateSweep(sweepRadians) {
    const sweep = THREE.MathUtils.clamp(sweepRadians, 0, TAU);
    const fullOrPartial = sweep <= 0.002 ? 0 : sweep;
    const angleFraction = THREE.MathUtils.clamp(
      fullOrPartial / TAU,
      0,
      1,
    );
    const usedSegments = Math.min(
      SEG_PHI,
      Math.ceil(angleFraction * SEG_PHI),
    );

    const outerCount = usedSegments * SEG_X * 6;
    const innerCount = usedSegments * SEG_X * 6;
    outer.geometry.setDrawRange(0, outerCount);
    inner.geometry.setDrawRange(0, innerCount);
    outer.visible = outerCount > 0;
    inner.visible = innerCount > 0;

    const capCount = usedSegments * CAP_R * 6;
    if (capLow) {
      capLow.geometry.setDrawRange(0, capCount);
      capLow.visible = capCount > 0 && currentMode !== "wire";
    }
    if (capHigh) {
      capHigh.geometry.setDrawRange(0, capCount);
      capHigh.visible = capCount > 0 && currentMode !== "wire";
    }

    cutStart.rotation.x = problem.startAngle;
    cutEnd.rotation.x = problem.startAngle + sweep;
    outlineStart.rotation.x = problem.startAngle;
    outlineEnd.rotation.x = problem.startAngle + sweep;
    lastSweep = sweep;
    syncCutState();

    const ringVertexCount =
      usedSegments <= 0 ? 0 : Math.min(SEG_PHI, usedSegments) + 1;
    for (const ring of ringLines) {
      ring.geometry.setDrawRange(0, ringVertexCount);
      ring.visible = ringVertexCount > 1;
    }
    for (const line of meridianLines) {
      line.visible =
        sweep > 0.003 && line.userData.relativeAngle <= sweep + 0.0001;
    }
  }

  function setCutVisible(wanted) {
    lastCutStart = wanted;
    lastCutEnd = wanted;
    outlineStart.userData.wanted = wanted;
    outlineEnd.userData.wanted = wanted;
    cutStart.userData.wanted = wanted;
    cutEnd.userData.wanted = wanted;
    syncCutState();
  }

  applyMode("solid");

  return {
    group,
    updateSweep,
    applyMode,
    setCutVisible,
    materials: {
      outerMaterial,
      innerMaterial,
      capMaterial,
      cutMaterial,
      contourMaterial,
    },
    parts: {
      outer,
      inner,
      capLow,
      capHigh,
      cutStart,
      cutEnd,
      outlineStart,
      outlineEnd,
    },
    getMode: () => currentMode,
    getSweep: () => lastSweep,
  };
}

function washerGeometry(ro, ri, length, segments = 64) {
  const geometries = [];

  if (ri < 0.0005) {
    const disc = new THREE.CylinderGeometry(ro, ro, length, segments, 1, false);
    disc.rotateZ(-Math.PI / 2);
    geometries.push(disc);
  } else {
    const outerWall = new THREE.CylinderGeometry(
      ro,
      ro,
      length,
      segments,
      1,
      true,
    );
    outerWall.rotateZ(-Math.PI / 2);
    const innerWall = new THREE.CylinderGeometry(
      ri,
      ri,
      length,
      segments,
      1,
      true,
    );
    innerWall.rotateZ(-Math.PI / 2);
    const capA = new THREE.RingGeometry(ri, ro, segments, 1);
    capA.rotateY(-Math.PI / 2);
    capA.translate(-length / 2, 0, 0);
    const capB = new THREE.RingGeometry(ri, ro, segments, 1);
    capB.rotateY(-Math.PI / 2);
    capB.translate(length / 2, 0, 0);
    geometries.push(outerWall, innerWall, capA, capB);
  }

  return mergeGeometriesSimple(geometries);
}

function mergeGeometriesSimple(geometries) {
  const positions = [];
  const normals = [];
  const uvs = [];

  for (const geometry of geometries) {
    const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = nonIndexed.getAttribute("position");
    const nor = nonIndexed.getAttribute("normal");
    const uv = nonIndexed.getAttribute("uv");
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nor) normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
    }
    if (nonIndexed !== geometry) nonIndexed.dispose();
    geometry.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  if (normals.length) {
    merged.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(normals, 3),
    );
  }
  if (uvs.length) {
    merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  }
  merged.computeBoundingSphere();
  return merged;
}

export function createWashers(problem, n) {
  const group = new THREE.Group();
  group.name = "Riemann washer approximation";
  group.position.y = problem.axisValue;

  const material = new THREE.MeshStandardMaterial({
    color: 0xe9782e,
    emissive: 0x2b0f03,
    emissiveIntensity: 0.2,
    roughness: 0.38,
    metalness: 0.12,
    transparent: true,
    opacity: 0.86,
    side: THREE.DoubleSide,
    depthWrite: true,
  });

  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0xffe4c5,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });

  const start = problem.domain?.x0 ?? 0;
  const end = problem.domain?.x1 ?? 4;
  const dx = (end - start) / n;
  const gap = Math.min(dx * 0.09, 0.012);
  let estimate = 0;

  for (let i = 0; i < n; i++) {
    const x0 = start + i * dx;
    const xm = x0 + dx / 2;
    const ro = problem.outer(xm);
    const ri = problem.inner(xm);
    const length = Math.max(dx - gap, dx * 0.45);
    const geometry = washerGeometry(ro, ri, length, n > 64 ? 44 : 60);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = x0 + dx / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const edgeGeometry = new THREE.EdgesGeometry(geometry, 35);
    const edges = new THREE.LineSegments(edgeGeometry, lineMaterial);
    mesh.add(edges);

    estimate += Math.PI * (ro * ro - ri * ri) * dx;
  }

  group.userData.estimate = estimate;
  return group;
}
