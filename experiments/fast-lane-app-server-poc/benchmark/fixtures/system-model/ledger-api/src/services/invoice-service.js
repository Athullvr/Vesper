const { normalizeRecipient } = require("../lib/recipient");
const { insertIfAbsent } = require("../storage/invoice-repository");

async function recordInvoice(input, { invoices }) {
  const recipient = normalizeRecipient(input.recipient);
  return insertIfAbsent(invoices, input.idempotencyKey, { ...input, recipient });
}

module.exports = { recordInvoice };
