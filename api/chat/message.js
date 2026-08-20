/* portal-rag-assistant — Vercel Serverless 函数：POST /api/chat/message（转发用户消息） */
"use strict";

var qoder = require("../../lib/qoder.js");

module.exports = function handler(req, res) {
  if (req.method !== "POST") {
    qoder.sendJSON(res, 405, { error: { message: "method_not_allowed" } });
    return;
  }
  qoder.handleSendMessage(req, res);
};
