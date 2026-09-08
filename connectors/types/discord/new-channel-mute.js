'use strict';
/**
 * New Discord channels default muted until the owner unmutes.
 * Existing explicit mute/enable map is unchanged.
 */
function schemaChannelsDefault() {
  return false;
}

function resolveChannelsDefault(cfgDefault, persisted) {
  if (typeof persisted === 'boolean') return persisted;
  return cfgDefault === true;
}

function muteNewChannel(channelStates, channelId) {
  const id = String(channelId || '');
  if (!id) return false;
  if (channelStates.has(id)) return false;
  channelStates.set(id, false);
  return true;
}

module.exports = { schemaChannelsDefault, resolveChannelsDefault, muteNewChannel };
