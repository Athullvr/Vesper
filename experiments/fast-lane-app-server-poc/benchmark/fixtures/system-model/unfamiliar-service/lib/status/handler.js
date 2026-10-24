function buildStatusHandler() {
  return () => ({ status: "ready" });
}

module.exports = { buildStatusHandler };
