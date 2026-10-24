const registry = require("./registry");
const { createServer } = require("./transport/http-adapter");

function startService() {
  return createServer(registry);
}

module.exports = { startService };
