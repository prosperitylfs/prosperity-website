// Single place that decides which adapter Call/Text/Email use.
//
// Defaults to the fake adapter always. The live Twilio adapter is only ever
// selected by an exact, case-sensitive match on
// process.env.COMMUNICATION_PROVIDER === 'twilio' — a server-side-only
// environment variable. Missing, empty, misspelled ('Twilio', 'TWILIO',
// 'live'), or any other value keeps the fake adapter active; there is no
// other condition anywhere in this file that could select the live
// adapter. getAdapter() takes no arguments, so nothing a browser sends can
// ever influence this decision — the only input is the server process's
// own environment.

const fakeAdapter = require('./fakeAdapter');
const liveTwilioAdapter = require('./liveTwilioAdapter');

function getAdapter() {
  if (process.env.COMMUNICATION_PROVIDER === 'twilio') {
    return liveTwilioAdapter;
  }
  return fakeAdapter;
}

module.exports = { getAdapter };
