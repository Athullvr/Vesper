const path = process.env.INVOICE_ARCHIVE_WORKER || "../../generated/invoice-archive-worker";

function loadArchiveWorker() {
  return require(path);
}

module.exports = { loadArchiveWorker };
