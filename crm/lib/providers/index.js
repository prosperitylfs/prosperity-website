// Single place that decides which adapter Call/Text/Email use. Always
// returns the fake adapter in this checkpoint — there is no environment
// variable, config flag, or condition anywhere that could select
// liveAdapterStub.js; it isn't even required here. Swapping this to a real
// adapter later is the ONLY change needed to activate live sending.

const fakeAdapter = require('./fakeAdapter');

function getAdapter() {
  return fakeAdapter;
}

module.exports = { getAdapter };
