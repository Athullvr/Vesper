#!/usr/bin/env node
"use strict";

const { runVesper } = require("../cli");

runVesper().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`[Vesper error] ${String(error?.message || error).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")}\n`);
  process.exitCode = 1;
});
