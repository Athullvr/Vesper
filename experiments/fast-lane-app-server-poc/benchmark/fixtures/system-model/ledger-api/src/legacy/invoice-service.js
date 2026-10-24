// This archived implementation matches the recordInvoice literal search but is not imported by the server.
function recordInvoice(input) {
  return { ...input, source: "legacy-export" };
}

module.exports = { recordInvoice };
