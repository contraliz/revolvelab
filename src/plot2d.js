const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function niceStep(range, target = 9) {
  const rough = Math.max(range / target, 1e-12);
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const fraction = rough / power;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

function formatTick(value, step) {
  if (Math.abs(value) < step * 1e-6) return "0";
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return Number(value.toFixed(decimals)).toString().replace("-", "−");
}

export class RegionPlot {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.model = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.view = { xMin: -6, xMax: 6, yMin: -4, yMax: 4 };
    this.viewInitialized = false;
    this.userAdjusted = false;
    this.dragging = false;
    this.lastPointer = null;
    this.frame = 0;
    this.autoFit = true;

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleDoubleClick = this.handleDoubleClick.bind(this);

    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerUp);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    canvas.addEventListener("dblclick", this.handleDoubleClick);

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => this.requestRender());
    }
  }

  setModel(model) {
    const boundsChanged = this.boundsSignature(model) !== this.boundsSignature(this.model);
    this.model = model;
    if (!this.viewInitialized || (this.autoFit && boundsChanged)) {
      this.fit({ silent: true });
    } else {
      this.requestRender();
    }
  }

  boundsSignature(model) {
    if (!model?.bounds) return "";
    const { xMin, xMax, yMin, yMax } = model.bounds;
    return [xMin, xMax, yMin, yMax]
      .map((value) => value.toFixed(5))
      .join("|");
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (width === this.width && height === this.height && dpr === this.dpr) {
      this.requestRender();
      return;
    }
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.viewInitialized) {
      this.fit({ silent: true });
    } else {
      this.constrainView();
      this.requestRender();
    }
  }

  fit(options = {}) {
    const bounds = this.model?.bounds;
    let xMin = -6;
    let xMax = 6;
    let yMin = -4;
    let yMax = 4;
    if (bounds) {
      xMin = bounds.xMin;
      xMax = bounds.xMax;
      yMin = bounds.yMin;
      yMax = bounds.yMax;
    }
    const width = Math.max(xMax - xMin, 0.5);
    const height = Math.max(yMax - yMin, 0.5);
    const aspect = this.width / Math.max(this.height, 1);

    if (width / height > aspect) {
      const targetHeight = width / aspect;
      const mid = (yMin + yMax) / 2;
      yMin = mid - targetHeight / 2;
      yMax = mid + targetHeight / 2;
    } else {
      const targetWidth = height * aspect;
      const mid = (xMin + xMax) / 2;
      xMin = mid - targetWidth / 2;
      xMax = mid + targetWidth / 2;
    }

    this.view = { xMin, xMax, yMin, yMax };
    this.viewInitialized = true;
    if (options.userAction) {
      this.userAdjusted = true;
    } else {
      this.userAdjusted = false;
    }
    this.requestRender();
  }

  constrainView() {
    const maxSpan = 120;
    let { xMin, xMax, yMin, yMax } = this.view;
    if (xMax - xMin > maxSpan) {
      const mid = (xMin + xMax) / 2;
      xMin = mid - maxSpan / 2;
      xMax = mid + maxSpan / 2;
    }
    if (yMax - yMin > maxSpan) {
      const mid = (yMin + yMax) / 2;
      yMin = mid - maxSpan / 2;
      yMax = mid + maxSpan / 2;
    }
    const minSpan = 0.02;
    if (xMax - xMin < minSpan) {
      const mid = (xMin + xMax) / 2;
      xMin = mid - minSpan / 2;
      xMax = mid + minSpan / 2;
    }
    if (yMax - yMin < minSpan) {
      const mid = (yMin + yMax) / 2;
      yMin = mid - minSpan / 2;
      yMax = mid + minSpan / 2;
    }
    this.view = { xMin, xMax, yMin, yMax };
  }

  toScreenX(x) {
    return ((x - this.view.xMin) / (this.view.xMax - this.view.xMin)) * this.width;
  }

  toScreenY(y) {
    return ((this.view.yMax - y) / (this.view.yMax - this.view.yMin)) * this.height;
  }

  toWorldX(px) {
    return this.view.xMin + (px / this.width) * (this.view.xMax - this.view.xMin);
  }

  toWorldY(py) {
    return this.view.yMax - (py / this.height) * (this.view.yMax - this.view.yMin);
  }

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const context = this.context;
    if (!context) return;
    const width = this.width;
    const height = this.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#0c1014";
    context.fillRect(0, 0, width, height);

    this.drawGrid(context);
    this.drawRegion(context);
    this.drawCurves(context);
    this.drawAxisLine(context);
    this.drawCornerReadout(context);
  }

  drawGrid(context) {
    const { xMin, xMax, yMin, yMax } = this.view;
    const xRange = xMax - xMin;
    const yRange = yMax - yMin;
    const step = niceStep(Math.max(xRange, yRange / 1.6), 9);
    const minorStep = step / 5;

    const drawGridLines = (spacing, color, lineWidth) => {
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      const firstX = Math.ceil(xMin / spacing) * spacing;
      for (let x = firstX; x <= xMax + spacing * 1e-6; x += spacing) {
        const px = Math.round(this.toScreenX(x)) + 0.5;
        if (px < -1 || px > this.width + 1) continue;
        context.moveTo(px, 0);
        context.lineTo(px, this.height);
      }
      const firstY = Math.ceil(yMin / spacing) * spacing;
      for (let y = firstY; y <= yMax + spacing * 1e-6; y += spacing) {
        const py = Math.round(this.toScreenY(y)) + 0.5;
        if (py < -1 || py > this.height + 1) continue;
        context.moveTo(0, py);
        context.lineTo(this.width, py);
      }
      context.stroke();
    };

    drawGridLines(minorStep, "rgba(157, 174, 192, 0.065)", 1);
    drawGridLines(step, "rgba(157, 174, 192, 0.13)", 1);

    // Axes through the true origin.
    context.lineWidth = 1.35;
    context.strokeStyle = "rgba(207, 219, 231, 0.43)";
    context.beginPath();
    if (xMin <= 0 && xMax >= 0) {
      const px = Math.round(this.toScreenX(0)) + 0.5;
      context.moveTo(px, 0);
      context.lineTo(px, this.height);
    }
    if (yMin <= 0 && yMax >= 0) {
      const py = Math.round(this.toScreenY(0)) + 0.5;
      context.moveTo(0, py);
      context.lineTo(this.width, py);
    }
    context.stroke();

    const textColor = "rgba(166, 180, 194, 0.68)";
    context.fillStyle = textColor;
    context.font = '11px "MesloLGS Nerd Font", monospace';
    context.textAlign = "center";
    context.textBaseline = "top";

    const firstLabelX = Math.ceil(xMin / step) * step;
    for (let x = firstLabelX; x <= xMax + step * 1e-6; x += step) {
      if (Math.abs(x) < step * 1e-6) continue;
      const px = this.toScreenX(x);
      if (px < 18 || px > this.width - 12) continue;
      const axisY = yMin <= 0 && yMax >= 0 ? this.toScreenY(0) : this.height - 15;
      const py = clamp(axisY + 5, 4, this.height - 16);
      context.fillText(formatTick(x, step), px, py);
    }

    context.textAlign = "right";
    context.textBaseline = "middle";
    const firstLabelY = Math.ceil(yMin / step) * step;
    for (let y = firstLabelY; y <= yMax + step * 1e-6; y += step) {
      if (Math.abs(y) < step * 1e-6) continue;
      const py = this.toScreenY(y);
      if (py < 12 || py > this.height - 18) continue;
      const axisX = xMin <= 0 && xMax >= 0 ? this.toScreenX(0) : 8;
      const px = clamp(axisX - 6, 28, this.width - 5);
      context.fillText(formatTick(y, step), px, py);
    }

    context.textAlign = "right";
    context.textBaseline = "bottom";
    context.fillStyle = "rgba(198, 211, 224, 0.5)";
    context.fillText("x", this.width - 10, this.height - 7);
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText("y", 10, 9);
  }

  drawRegion(context) {
    if (!this.model?.cells?.length) return;
    const upperLineColor = (cell) => cell.upperLine?.color || "#4bd7c2";
    const lowerLineColor = (cell) => cell.lowerLine?.color || "#ff9950";

    for (const cell of this.model.cells) {
      const samples = Math.max(
        40,
        Math.min(420, Math.ceil(this.toScreenX(cell.b) - this.toScreenX(cell.a))),
      );
      const upper = [];
      const lower = [];
      for (let index = 0; index <= samples; index++) {
        const x = cell.a + ((cell.b - cell.a) * index) / samples;
        const upperValue = cell.upper(x);
        const lowerValue = cell.lower(x);
        if (Number.isFinite(upperValue) && Number.isFinite(lowerValue)) {
          upper.push([this.toScreenX(x), this.toScreenY(upperValue)]);
          lower.push([this.toScreenX(x), this.toScreenY(lowerValue)]);
        }
      }
      if (upper.length < 2) continue;

      const gradient = context.createLinearGradient(
        0,
        Math.min(...upper.map((point) => point[1])),
        0,
        Math.max(...lower.map((point) => point[1])),
      );
      gradient.addColorStop(0, hexToRgba(upperLineColor(cell), 0.26));
      gradient.addColorStop(1, hexToRgba(lowerLineColor(cell), 0.16));

      context.beginPath();
      context.moveTo(upper[0][0], upper[0][1]);
      for (let index = 1; index < upper.length; index++) {
        context.lineTo(upper[index][0], upper[index][1]);
      }
      for (let index = lower.length - 1; index >= 0; index--) {
        context.lineTo(lower[index][0], lower[index][1]);
      }
      context.closePath();
      context.fillStyle = gradient;
      context.fill();
    }
  }

  drawCurves(context) {
    if (!this.model?.lines?.length) return;
    context.save();
    context.beginPath();
    context.rect(0, 0, this.width, this.height);
    context.clip();

    for (const line of this.model.lines) {
      const color = line.color || "#ff9950";
      const points = [];
      const stride = 1.4;
      let previousY = null;
      context.beginPath();
      let drawing = false;

      for (let px = -2; px <= this.width + 2; px += stride) {
        const x = this.toWorldX(px);
        let y;
        try {
          y = line.evaluate(x);
        } catch {
          y = Number.NaN;
        }
        if (!Number.isFinite(y)) {
          drawing = false;
          previousY = null;
          continue;
        }
        const py = this.toScreenY(y);
        if (
          previousY !== null &&
          Math.abs(py - previousY) > this.height * 1.8
        ) {
          drawing = false;
        }
        if (!drawing) {
          context.moveTo(px, py);
          drawing = true;
        } else {
          context.lineTo(px, py);
        }
        previousY = py;
        points.push([px, py]);
      }

      context.strokeStyle = color;
      context.lineWidth = 2.15;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.shadowColor = hexToRgba(color, 0.35);
      context.shadowBlur = 8;
      context.stroke();
      context.shadowBlur = 0;

      const last = [...points].reverse().find(
        ([px, py]) => px > 14 && px < this.width - 10 && py > 10 && py < this.height - 10,
      );
      if (last) {
        context.beginPath();
        context.arc(last[0], last[1], 2.6, 0, TAU);
        context.fillStyle = color;
        context.fill();
      }
    }
    context.restore();
  }

  drawAxisLine(context) {
    const axis = this.model?.axis;
    if (!axis) return;
    const { point, direction } = axis;
    const extension = Math.max(this.width, this.height) * 3;
    const start = {
      x: point.x - direction.x * extension,
      y: point.y - direction.y * extension,
    };
    const end = {
      x: point.x + direction.x * extension,
      y: point.y + direction.y * extension,
    };

    context.save();
    context.beginPath();
    context.rect(0, 0, this.width, this.height);
    context.clip();
    context.beginPath();
    context.setLineDash([8, 7]);
    context.lineDashOffset = 0;
    context.strokeStyle = "rgba(255, 153, 80, 0.9)";
    context.lineWidth = 1.6;
    context.moveTo(this.toScreenX(start.x), this.toScreenY(start.y));
    context.lineTo(this.toScreenX(end.x), this.toScreenY(end.y));
    context.stroke();
    context.setLineDash([]);

    const labelX = clamp(this.toScreenX(point.x), 100, this.width - 80);
    const labelY = clamp(this.toScreenY(point.y) - 12, 22, this.height - 28);
    context.font = '600 11px "MesloLGS Nerd Font", monospace';
    const label = axis.label;
    const textWidth = context.measureText(label).width;
    context.fillStyle = "rgba(13, 16, 20, 0.86)";
    context.fillRect(labelX - textWidth / 2 - 8, labelY - 13, textWidth + 16, 20);
    context.strokeStyle = "rgba(255, 153, 80, 0.32)";
    context.lineWidth = 1;
    context.strokeRect(labelX - textWidth / 2 - 8, labelY - 13, textWidth + 16, 20);
    context.fillStyle = "#ffb06e";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, labelX, labelY - 3);
    context.restore();
  }

  drawCornerReadout(context) {
    if (this.width < 540) return;
    const { xMin, xMax, yMin, yMax } = this.view;
    const step = niceStep(Math.max(xMax - xMin, yMax - yMin), 7);
    context.font = '10px "MesloLGS Nerd Font", monospace';
    context.fillStyle = "rgba(159, 172, 186, 0.54)";
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.fillText(
      `x: ${formatTick(xMin, step)} … ${formatTick(xMax, step)}     y: ${formatTick(
        yMin,
        step,
      )} … ${formatTick(yMax, step)}`,
      14,
      this.height - 13,
    );
  }

  handlePointerDown(event) {
    if (event.button !== 0) return;
    this.dragging = true;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = "grabbing";
  }

  handlePointerMove(event) {
    if (!this.dragging || !this.lastPointer) return;
    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    const scaleX = (this.view.xMax - this.view.xMin) / this.width;
    const scaleY = (this.view.yMax - this.view.yMin) / this.height;
    this.view.xMin -= dx * scaleX;
    this.view.xMax -= dx * scaleX;
    this.view.yMin += dy * scaleY;
    this.view.yMax += dy * scaleY;
    this.userAdjusted = true;
    this.autoFit = false;
    this.requestRender();
  }

  handlePointerUp(event) {
    if (!this.dragging) return;
    this.dragging = false;
    this.lastPointer = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.canvas.style.cursor = "grab";
  }

  handleWheel(event) {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const x = this.toWorldX(px);
    const y = this.toWorldY(py);
    const factor = Math.exp(event.deltaY * 0.0014);
    this.view.xMin = x + (this.view.xMin - x) * factor;
    this.view.xMax = x + (this.view.xMax - x) * factor;
    this.view.yMin = y + (this.view.yMin - y) * factor;
    this.view.yMax = y + (this.view.yMax - y) * factor;
    this.constrainView();
    this.userAdjusted = true;
    this.autoFit = false;
    this.requestRender();
  }

  handleDoubleClick() {
    this.autoFit = true;
    this.fit({ userAction: false });
  }
}

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
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
