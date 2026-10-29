// Debugger acceptance fixture. Breakpoint lines are located by the marker comments; keep one
// statement per line.
/* global window, document */
window.dbgResults = [];
window.dbgToken = 'tok-@@RUN_ID@@';

function compute(input) {
  const scale = 2;
  const token = window.dbgToken; // @@token
  const doubled = input * scale; // @@doubled
  const label = 'v' + doubled; // @@label
  return { doubled, label, token }; // @@return
}

function trigger(input) {
  window.dbgResults.push(compute(input).doubled); // @@trigger
}

function later(input) {
  setTimeout(() => trigger(input), 300);
  return 'scheduled';
}

function sendXhr() {
  setTimeout(() => fetch('/debugger-xhr?run=@@RUN_ID@@').catch(() => {}), 300);
  return 'scheduled';
}

function clickLater() {
  setTimeout(() => document.querySelector('#ping').click(), 300);
  return 'scheduled';
}

function pauseProbe() {
  // eslint-disable-next-line no-debugger -- a disarmed session must skip this statement
  debugger;
  return 'not-paused';
}

document.querySelector('#ping').addEventListener('click', () => {
  window.dbgClicks = (window.dbgClicks || 0) + 1; // @@click
});
