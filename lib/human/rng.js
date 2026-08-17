'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed) {
  const normalized = Number.isFinite(seed) ? Math.floor(seed) : Date.now() ^ (process.pid << 16);
  return mulberry32(normalized);
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function uniform(rng, min, max) {
  return min + (max - min) * rng();
}

function gaussian(rng, mean, sd) {
  let u1 = rng();
  let u2 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  const mag = Math.sqrt(-2 * Math.log(u1));
  const z = mag * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}

function sampleClamped(rng, mean, sd, min, max) {
  return clamp(gaussian(rng, mean, sd), min, max);
}

function randomInt(rng, min, max) {
  return Math.floor(uniform(rng, min, max + 1));
}

function chance(rng, probability) {
  return rng() < probability;
}

module.exports = {
  mulberry32,
  createRng,
  clamp,
  uniform,
  gaussian,
  sampleClamped,
  randomInt,
  chance,
};
