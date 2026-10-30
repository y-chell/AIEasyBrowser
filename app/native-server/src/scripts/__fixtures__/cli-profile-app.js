'use strict';

/* global window, Worker */
// Each instance is one countable heap object; grow adds a known number between two samples.
function ProfileLeak(index) {
  this.index = index;
}

function profileLeaf(value) {
  return (value * 7) % 13;
}

// Busy loop for a CPU profile: profileHot and profileLeaf are the expected hot functions.
function profileHot(ms) {
  const end = performance.now() + ms;
  let total = 0;
  while (performance.now() < end) {
    for (let index = 0; index < 1000; index += 1) total += profileLeaf(index);
  }
  return total;
}

// Never called: it stays unused code.
function profileNeverCalled() {
  return 'unused '.repeat(20);
}

window.profileFixture = {
  hot: profileHot,
  neverCalled: profileNeverCalled,
  leaks: [],
  grow(count) {
    for (let index = 0; index < count; index += 1) this.leaks.push(new ProfileLeak(index));
    return this.leaks.length;
  },
  release() {
    this.leaks = [];
    return 0;
  },
  worker: new Worker('/profile-worker.js'),
};
window.ProfileLeak = ProfileLeak;
