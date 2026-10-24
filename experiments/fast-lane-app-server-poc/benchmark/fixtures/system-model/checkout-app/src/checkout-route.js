const { validateCheckout } = require("./checkout-validation");
const { createOrder } = require("./checkout-service");

function checkoutRoute(request) {
  const checked = validateCheckout(request.body);
  if (!checked.valid) return { status: 400 };
  return createOrder(checked.value);
}

module.exports = { checkoutRoute };
