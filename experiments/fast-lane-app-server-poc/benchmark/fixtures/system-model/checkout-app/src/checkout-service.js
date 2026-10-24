const { saveOrder } = require("./order-repository");

function createOrder(details) {
  return saveOrder({ ...details, state: "created" });
}

module.exports = { createOrder };
