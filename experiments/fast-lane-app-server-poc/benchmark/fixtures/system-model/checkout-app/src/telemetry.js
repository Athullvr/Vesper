function recordCheckoutMetric(name) {
  return { recorded: Boolean(name) };
}

module.exports = { recordCheckoutMetric };
