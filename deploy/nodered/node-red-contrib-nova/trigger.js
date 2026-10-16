"use strict";

const { eventToken, request } = require("./shared");

const EVENT = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const EVENT_ID = /^[\w.:-]{1,80}$/;

module.exports = function registerTrigger(RED) {
  function NovaTrigger(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on("input", async (msg, send, done) => {
      send ||= node.send.bind(node);
      try {
        const event = String(config.event || msg.event || "").trim();
        if (!EVENT.test(event)) throw new Error("Invalid NOVA event name");
        const eventId = String(msg.eventId || msg._msgid || "").trim();
        if (eventId && !EVENT_ID.test(eventId))
          throw new Error("Invalid NOVA event id");
        msg.nova = await request(
          "/api/integrations/node-red/trigger",
          { event, ...(eventId ? { eventId } : {}) },
          { token: eventToken() },
        );
        send(msg);
        done?.();
      } catch (error) {
        const message = String(error?.message || error).slice(0, 240);
        if (done) done(new Error(message));
        else node.error(message, msg);
      }
    });
  }
  RED.nodes.registerType("nova-trigger", NovaTrigger);
};
