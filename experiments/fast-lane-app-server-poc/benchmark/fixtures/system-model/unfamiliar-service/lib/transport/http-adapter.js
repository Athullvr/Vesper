function createServer(handlers) {
  return { dispatch: (name, request) => handlers[name](request) };
}

module.exports = { createServer };
