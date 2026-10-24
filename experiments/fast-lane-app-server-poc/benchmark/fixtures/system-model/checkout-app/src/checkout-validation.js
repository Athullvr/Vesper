function validateCheckout(input) {
  if (!input || typeof input.email !== "string") return { valid: false };
  return { valid: true, value: input };
}

module.exports = { validateCheckout };
