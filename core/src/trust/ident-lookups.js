'use strict';

/** Identifier pairs for trust.resolve. Email never matches raw_username (display name). */
function identifierLookups(surface, sender = {}) {
  const { raw_id, raw_username, api_key } = sender;
  const pairs = [[surface, raw_id]];
  if (surface !== 'email') pairs.push([surface, raw_username]);
  pairs.push(['apikey', api_key]);
  return pairs.filter(([, v]) => v != null && String(v) !== '');
}

module.exports = { identifierLookups };
