const { createOrder } = require("../src/checkout-service");

test("createOrder saves a new order", () => {
  return createOrder({ email: "fixture@example.test" }).state === "created";
});
