"use strict";

const { MAX_CHAT_RESPONSE_BYTES, eventToken, request } = require("./shared");

module.exports = function registerAsk(RED) {
  function NovaAsk(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.on("input", async (msg, send, done) => {
      send ||= node.send.bind(node);
      try {
        const message = typeof msg.payload === "string" ? msg.payload : "";
        if (!message.trim() || message.length > 10000)
          throw new Error(
            "NOVA vraag expects 1–10000 characters in msg.payload",
          );
        const proactive = config.proactive === true;
        const result = await request(
          proactive ? "/api/proactive/ask" : "/api/chat",
          {
            sessionId: `nova_${String(node.id)
              .replace(/[^A-Za-z0-9_-]/g, "_")
              .slice(0, 80)}`,
            message,
            inputMode: "text",
            ...(proactive
              ? { modelRole: "summary", responseLanguage: "nl" }
              : {}),
          },
          {
            ...(proactive ? { token: eventToken() } : {}),
            maxBytes: MAX_CHAT_RESPONSE_BYTES,
            timeoutMs: 120000,
          },
        );
        msg.payload = result.reply;
        msg.nova = result;
        send(msg);
        done?.();
      } catch (error) {
        const message = String(error?.message || error).slice(0, 240);
        if (done) done(new Error(message));
        else node.error(message, msg);
      }
    });
  }
  RED.nodes.registerType("nova-ask", NovaAsk);
};
