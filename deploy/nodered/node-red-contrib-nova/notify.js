"use strict";

const { eventPayload, eventToken, request } = require("./shared");

module.exports = function registerNotify(RED) {
  function NovaNotify(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on("input", async (msg, send, done) => {
      send ||= node.send.bind(node);
      try {
        const payload = eventPayload("alert", msg.payload);
        msg.nova = await request("/api/integrations/node-red/events", payload, {
          token: eventToken(),
        });
        send(msg);
        done?.();
      } catch (error) {
        const message = String(error?.message || error).slice(0, 240);
        if (done) done(new Error(message));
        else node.error(message, msg);
      }
    });
  }
  RED.nodes.registerType("nova-notify", NovaNotify);
};
