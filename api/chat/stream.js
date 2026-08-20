/* portal-rag-assistant — Vercel Serverless 函数：GET /api/chat/stream（SSE 事件流代理）
   maxDuration 尽量拉长以保持 SSE 长连接；Hobby 计划上限以 Vercel 实际为准 */
"use strict";

var qoder = require("../../lib/qoder.js");

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    qoder.sendJSON(res, 405, { error: { message: "method_not_allowed" } });
    return;
  }
  var query = new URL(req.url, "http://localhost").searchParams;
  qoder.handleStream(req, res, query);
};

module.exports.config = {
  maxDuration: 60
};
