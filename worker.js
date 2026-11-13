import { carve } from './core.js';
self.onmessage = ({ data }) => {
  try {
    const result = carve(data.image, data.axis, data.count, (progress) =>
      self.postMessage({ progress }),
    );
    self.postMessage({ result }, [result.pixels.buffer, result.mask.buffer, result.origin.buffer]);
  } catch (e) {
    self.postMessage({ error: e.message });
  }
};
