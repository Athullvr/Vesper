const { createInvoiceRouter } = require("./routes/invoice-router");

function createServer(dependencies) {
  return { handle: createInvoiceRouter(dependencies) };
}

module.exports = { createServer };
