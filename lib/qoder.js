/* ============================================================
   portal-rag-assistant — Qoder Cloud Agents 代理核心逻辑（本地 server.js 与 Vercel api/ 共用）
   凭证只从环境变量读取（QODER_PAT / QODER_IDENTITY_ID / QODER_TEMPLATE_ID），
   本地开发可从项目根目录 .env 加载；PAT 绝不下发到浏览器。
   ============================================================ */
"use strict";

var https = require("https");
var fs = require("fs");
var path = require("path");

var UPSTREAM_HOST = "api.qoder.com";

/* 极简 .env 加载：仅在本地生效（Vercel 上无此文件，环境变量由 Dashboard 配置） */
function loadDotEnv(rootDir) {
  try {
    var raw = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
    raw.split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().charAt(0) === "#") return;
      var key = m[1];
      var val = m[2];
      if (
        (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
        (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    });
  } catch (e) { /* 无 .env 属正常情况 */ }
}

function getConfig() {
  return {
    pat: process.env.QODER_PAT || "",
    identityId: process.env.QODER_IDENTITY_ID || "",
    templateId: process.env.QODER_TEMPLATE_ID || ""
  };
}

function configMissing(cfg) {
  return !cfg.pat || !cfg.identityId || !cfg.templateId;
}

function sendJSON(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

/* 读取并解析 JSON 请求体（限制 64KB） */
function readJSONBody(req, cb) {
  var chunks = [];
  var size = 0;
  req.on("data", function (chunk) {
    size += chunk.length;
    if (size > 65536) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", function () {
    var raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return cb(null, {});
    try {
      cb(null, JSON.parse(raw));
    } catch (e) {
      cb(new Error("invalid_json"));
    }
  });
  req.on("error", function (e) {
    cb(e);
  });
}

/* 向上游 Qoder API 发起请求，回调返回原始上游响应流 */
function qoderRequest(cfg, method, apiPath, headers, body, cb) {
  var opts = {
    hostname: UPSTREAM_HOST,
    port: 443,
    method: method,
    path: apiPath,
    headers: Object.assign(
      {
        Authorization: "Bearer " + cfg.pat,
        Accept: "application/json"
      },
      headers || {}
    )
  };
  if (body !== undefined && body !== null) {
    opts.headers["Content-Type"] = "application/json";
  }
  var upstream = https.request(opts, function (upRes) {
    cb(null, upRes);
  });
  upstream.on("error", function (e) {
    cb(e);
  });
  if (body !== undefined && body !== null) {
    upstream.write(JSON.stringify(body));
  }
  upstream.end();
}

/* 读取上游响应为 JSON 并按上游状态码透传 */
function pipeUpstreamJSON(upRes, res) {
  var chunks = [];
  upRes.on("data", function (c) {
    chunks.push(c);
  });
  upRes.on("end", function () {
    var raw = Buffer.concat(chunks).toString("utf8");
    var status = upRes.statusCode || 502;
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = null;
    }
    if (parsed) {
      sendJSON(res, status, parsed);
    } else {
      sendJSON(res, status, { error: { message: raw || "upstream_error" } });
    }
  });
  upRes.on("error", function () {
    if (!res.headersSent) sendJSON(res, 502, { error: { message: "upstream_error" } });
  });
}

/* ---------- 三个代理端点的处理函数 ---------- */

function handleCreateSession(req, res) {
  var cfg = getConfig();
  if (configMissing(cfg)) {
    sendJSON(res, 500, { error: { message: "missing_server_config", hint: "请在服务端配置 QODER_PAT / QODER_IDENTITY_ID / QODER_TEMPLATE_ID" } });
    return;
  }
  readJSONBody(req, function (err, body) {
    if (err) {
      sendJSON(res, 400, { error: { message: "invalid_json" } });
      return;
    }
    var payload = {
      identity_id: cfg.identityId,
      template_id: cfg.templateId
    };
    if (body && typeof body.title === "string" && body.title.trim()) {
      payload.title = body.title.slice(0, 100);
    }
    qoderRequest(cfg, "POST", "/api/v1/forward/sessions", null, payload, function (err, upRes) {
      if (err) {
        sendJSON(res, 502, { error: { message: "upstream_error" } });
        return;
      }
      pipeUpstreamJSON(upRes, res);
    });
  });
}

function handleSendMessage(req, res) {
  var cfg = getConfig();
  if (configMissing(cfg)) {
    sendJSON(res, 500, { error: { message: "missing_server_config", hint: "请在服务端配置 QODER_PAT / QODER_IDENTITY_ID / QODER_TEMPLATE_ID" } });
    return;
  }
  readJSONBody(req, function (err, body) {
    if (err) {
      sendJSON(res, 400, { error: { message: "invalid_json" } });
      return;
    }
    var sessionId = body && body.session_id;
    var text = body && body.text;
    if (!sessionId || typeof text !== "string" || !text.trim()) {
      sendJSON(res, 400, { error: { message: "session_id and text are required" } });
      return;
    }
    text = text.slice(0, 4000);
    var apiPath = "/api/v1/forward/sessions/" +
      encodeURIComponent(sessionId) + "/events";
    var payload = {
      events: [
        { type: "user.message", content: [{ type: "text", text: text }] }
      ]
    };
    qoderRequest(cfg, "POST", apiPath, null, payload, function (err, upRes) {
      if (err) {
        sendJSON(res, 502, { error: { message: "upstream_error" } });
        return;
      }
      pipeUpstreamJSON(upRes, res);
    });
  });
}

/* SSE 代理：透传上游事件帧（含 id/event/data），支持 Last-Event-ID 续传 */
function handleStream(req, res, query) {
  var cfg = getConfig();
  if (configMissing(cfg)) {
    sendJSON(res, 500, { error: { message: "missing_server_config", hint: "请在服务端配置 QODER_PAT / QODER_IDENTITY_ID / QODER_TEMPLATE_ID" } });
    return;
  }
  var sessionId = query.get("session_id");
  if (!sessionId) {
    sendJSON(res, 400, { error: { message: "session_id is required" } });
    return;
  }
  var apiPath = "/api/v1/forward/sessions/" + encodeURIComponent(sessionId) +
    "/events/stream?event_deltas[]=agent.message&include_tool_calls=false&include_thinking=false";

  var headers = { Accept: "text/event-stream" };
  var lastId = req.headers["last-event-id"];
  if (lastId) headers["Last-Event-ID"] = lastId;

  qoderRequest(cfg, "GET", apiPath, headers, null, function (err, upRes) {
    if (err) {
      if (!res.headersSent) sendJSON(res, 502, { error: { message: "upstream_error" } });
      return;
    }
    if ((upRes.statusCode || 502) !== 200) {
      pipeUpstreamJSON(upRes, res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    upRes.pipe(res);
    req.on("close", function () {
      upRes.destroy();
    });
    upRes.on("error", function () {
      res.end();
    });
  });
}

module.exports = {
  loadDotEnv: loadDotEnv,
  getConfig: getConfig,
  sendJSON: sendJSON,
  handleCreateSession: handleCreateSession,
  handleSendMessage: handleSendMessage,
  handleStream: handleStream
};
