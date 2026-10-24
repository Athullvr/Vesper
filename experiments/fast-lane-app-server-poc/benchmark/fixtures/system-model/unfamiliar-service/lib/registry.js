const { buildStatusHandler } = require("./status/handler");

const handlers = { status: buildStatusHandler() };

module.exports = handlers;
