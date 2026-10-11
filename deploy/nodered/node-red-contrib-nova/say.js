"use strict";

const { MAX_AUDIO_BYTES, request } = require("./shared");

module.exports = function registerSay(RED) {
  function NovaSay(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on("input", async (msg, send, done) => {
      send ||= node.send.bind(node);
      try {
        const text = typeof msg.payload === "string" ? msg.payload : "";
        if (!text.trim() || text.length > 2000)
          throw new Error("NOVA zeg expects 1–2000 characters in msg.payload");
        const speech = await request(
          "/api/tts",
          { text, ...(config.voice ? { voice: config.voice } : {}) },
          { audio: true, maxBytes: MAX_AUDIO_BYTES, timeoutMs: 25000 },
        );
        msg.payload = speech;
        msg.nova = { text, contentType: "audio/mpeg" };
        send(msg);
        done?.();
      } catch (error) {
        const message = String(error?.message || error).slice(0, 240);
        if (done) done(new Error(message));
        else node.error(message, msg);
      }
    });
  }
  RED.nodes.registerType("nova-say", NovaSay);
};
