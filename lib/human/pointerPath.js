'use strict';

const { uniform, randomInt, clamp } = require('./rng');

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function cubicBezier(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function densePolyline(p0, p1, p2, p3, samples) {
  const points = [];
  for (let i = 0; i <= samples; i++) points.push(cubicBezier(p0, p1, p2, p3, i / samples));
  return points;
}

function resampleByArcLength(polyline, rng, segLen, maxStepPx) {
  const out = [];
  let carried = 0;
  let target = segLen * uniform(rng, 0.7, 1.0);
  for (let i = 1; i < polyline.length; i++) {
    const prev = polyline[i - 1];
    const cur = polyline[i];
    let segment = distance(prev, cur);
    let start = prev;
    while (segment > 0 && carried + segment >= target) {
      const remain = target - carried;
      const ratio = remain / segment;
      const point = {
        x: start.x + (cur.x - start.x) * ratio,
        y: start.y + (cur.y - start.y) * ratio,
      };
      out.push(point);
      start = point;
      segment = distance(start, cur);
      carried = 0;
      target = clamp(segLen * uniform(rng, 0.7, 1.15), 2, maxStepPx);
    }
    carried += segment;
  }
  return out;
}

function pointerPath(from, to, options = {}) {
  const rng = options.rng;
  const maxStepPx = options.maxStepPx || 90;
  const minSteps = options.minSteps || 12;
  const total = distance(from, to);

  if (total < maxStepPx) {
    const steps = randomInt(rng, minSteps, minSteps + 6);
    const points = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const jitterMag = (1 - t) * Math.min(6, total * 0.4 + 3);
      points.push({
        x: from.x + (to.x - from.x) * t + (rng() - 0.5) * jitterMag,
        y: from.y + (to.y - from.y) * t + (rng() - 0.5) * jitterMag,
      });
    }
    points[points.length - 1] = { x: to.x, y: to.y };
    return points;
  }

  const dirX = (to.x - from.x) / total;
  const dirY = (to.y - from.y) / total;
  const normX = -dirY;
  const normY = dirX;
  const bow = total * uniform(rng, 0.08, 0.22) * (rng() < 0.5 ? -1 : 1);
  const c1t = uniform(rng, 0.2, 0.4);
  const c2t = uniform(rng, 0.6, 0.85);
  const p1 = {
    x: from.x + dirX * total * c1t + normX * bow,
    y: from.y + dirY * total * c1t + normY * bow,
  };
  const p2 = {
    x: from.x + dirX * total * c2t + normX * bow * uniform(rng, 0.4, 0.9),
    y: from.y + dirY * total * c2t + normY * bow * uniform(rng, 0.4, 0.9),
  };

  const overshoot = total > 300 && rng() < 0.7;
  const target = overshoot
    ? { x: to.x + dirX * uniform(rng, 8, 24), y: to.y + dirY * uniform(rng, 8, 24) }
    : to;

  const polyline = densePolyline(from, p1, p2, target, 80);
  const desiredSteps = Math.max(minSteps, Math.ceil(total / maxStepPx) + randomInt(rng, 2, 6));
  const segLen = clamp(total / desiredSteps, 2, maxStepPx);
  const points = resampleByArcLength(polyline, rng, segLen, maxStepPx);

  if (overshoot) {
    const correctSteps = randomInt(rng, 2, 4);
    for (let i = 1; i <= correctSteps; i++) {
      const t = i / correctSteps;
      points.push({
        x: target.x + (to.x - target.x) * t + (rng() - 0.5) * 2,
        y: target.y + (to.y - target.y) * t + (rng() - 0.5) * 2,
      });
    }
  }
  points.push({ x: to.x, y: to.y });

  if (points.length < minSteps) {
    const fill = [];
    const prev = from;
    for (let i = 1; i <= minSteps; i++) {
      const t = i / minSteps;
      fill.push({ x: prev.x + (to.x - prev.x) * t, y: prev.y + (to.y - prev.y) * t });
    }
    return fill;
  }
  return points;
}

module.exports = { pointerPath, distance, maxSegment };

function maxSegment(from, points) {
  let prev = from;
  let max = 0;
  for (const p of points) {
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (d > max) max = d;
    prev = p;
  }
  return max;
}
