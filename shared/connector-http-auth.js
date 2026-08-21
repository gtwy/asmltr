'use strict';
/**
 * Connector loopback HTTP is not enough. /out and /send require ASMLTR_MANAGER_TOKEN.
 * Fail closed if the token is unset.
 */
const { bearerEqual } = require('./bearer-equal');

function connectorToken() {
  return process.env.ASMLTR_MANAGER_TOKEN || '';
}

function managerAuthHeaders(extra) {
  const token = connectorToken();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  return headers;
}

function requireConnectorToken(req, res, next) {
  const token = connectorToken();
  if (!token || !bearerEqual(req.get('authorization'), token)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
}

module.exports = { connectorToken, managerAuthHeaders, requireConnectorToken };
