const { recordInvoice } = require("../services/invoice-service");

function createInvoiceRouter(dependencies) {
  return async function handleInvoice(request) {
    return recordInvoice(request.body, dependencies);
  };
}

module.exports = { createInvoiceRouter };
