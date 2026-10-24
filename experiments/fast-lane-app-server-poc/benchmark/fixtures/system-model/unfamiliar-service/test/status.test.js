const { buildStatusHandler } = require("../lib/status/handler");

test("status is registered", () => {
  return buildStatusHandler()().status === "ready";
});
