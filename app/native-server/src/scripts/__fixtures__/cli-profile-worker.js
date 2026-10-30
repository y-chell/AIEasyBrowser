'use strict';

/* global self */
function profileWorkerHot(ms) {
  const end = performance.now() + ms;
  let total = 0;
  while (performance.now() < end) total += 1;
  return total;
}

self.profileWorkerHot = profileWorkerHot;
