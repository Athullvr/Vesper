function normalizeRecipient(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = { normalizeRecipient };
