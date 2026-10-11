"use strict";

module.exports = function registerNOVA(RED) {
  require("./say")(RED);
  require("./ask")(RED);
  require("./notify")(RED);
  require("./event")(RED);
};
