const db = require('../db');

function getProvider() {
  const name = (db.getConfig().provider || 'mock').toLowerCase();
  if (name === 'grizzly') return require('./grizzly');
  return require('./mock');
}

module.exports = { getProvider };
