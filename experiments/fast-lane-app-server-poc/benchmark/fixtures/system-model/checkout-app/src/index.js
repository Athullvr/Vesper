const routes = require("./checkout-route");

function createApplication() {
  return { checkout: routes.checkoutRoute };
}

module.exports = { createApplication };
