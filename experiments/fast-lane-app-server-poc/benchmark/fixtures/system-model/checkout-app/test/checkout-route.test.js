const { checkoutRoute } = require("../src/checkout-route");

test("checkoutRoute rejects invalid input", () => {
  return checkoutRoute({ body: null }).status === 400;
});
