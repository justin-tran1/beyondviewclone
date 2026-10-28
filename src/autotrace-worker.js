// Module worker that traces a floor plan image off the page's thread (see src/autotrace.js).
// In: { width, height, data, metersPerPixel } with data an RGBA Uint8ClampedArray and
// metersPerPixel a known scale or null. Out: { progress, phase } while it works, then { trace } or
// { error }.
import { traceFloorPlan } from './autotrace.js';

self.onmessage = (e) => {
  const { width, height, data, metersPerPixel } = e.data;
  try {
    const trace = traceFloorPlan({ width, height, data }, {
      onProgress: (progress, phase) => self.postMessage({ progress, phase }),
      metersPerPixel,
    });
    self.postMessage({ trace });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
