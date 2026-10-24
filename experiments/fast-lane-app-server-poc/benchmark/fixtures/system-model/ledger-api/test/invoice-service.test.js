const test = require("node:test");
const assert = require("node:assert/strict");
const { recordInvoice } = require("../src/services/invoice-service");

test("an idempotency key returns the first invoice", async () => {
  const invoices = new Map();
  const first = await recordInvoice({ id: "one", recipient: " Ada@Example.test ", idempotencyKey: "key-1" }, { invoices });
  const second = await recordInvoice({ id: "two", recipient: "other@example.test", idempotencyKey: "key-1" }, { invoices });
  assert.equal(first.recipient, "ada@example.test");
  assert.equal(second.id, "one");
});
