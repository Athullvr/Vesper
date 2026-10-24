async function insertIfAbsent(invoices, idempotencyKey, invoice) {
  if (invoices.has(idempotencyKey)) return invoices.get(idempotencyKey);
  invoices.set(idempotencyKey, invoice);
  return invoice;
}

module.exports = { insertIfAbsent };
