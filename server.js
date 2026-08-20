/* ============================================================
   portal-rag-assistant — 蔚小理汽车 NEXLI 官网 · 本地轻量服务端
   职责：
     1. 静态托管站点 4 个页面与资源
     2. POST /api/chat/session   → 创建 Qoder Session（复用 lib/qoder.js）
     3. POST /api/chat/message   → 转发用户消息
     4. GET  /api/chat/stream    → 代理 SSE 事件流
   仅使用 Node.js 内置模块（零依赖）。凭证从环境变量或项目根目录 .env 读取，
   参考 .env.example；PAT 只存在于服务端，绝不下发到浏览器。
   启动：npm start （或 node server.js）
   ============================================================ */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var qoder = require("./lib/qoder.js");

qoder.loadDotEnv(__dirname);

var PORT = Number(process.env.PORT || 8787);
var STATIC_ROOT = __dirname; // 站点文件与 server.js 同级

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

/* 不对外暴露服务端代码 / 配置 / 工程文件 */
var BLOCKED_PREFIXES = ["lib", "api", "server", "node_modules", "scripts"];
var BLOCKED_FILES = {
  "/package.json": 1, "/package-lock.json": 1, "/vercel.json": 1,
  "/.gitignore": 1, "/.env.example": 1
};

function isBlocked(pathname) {
  var rel = pathname.replace(/^\//, "");
  if (rel.charAt(0) === ".") return true; // 一切隐藏文件（含 .env）
  if (BLOCKED_FILES[pathname]) return true;
  var top = rel.split("/")[0];
  return BLOCKED_PREFIXES.indexOf(top) !== -1;
}

function serveStatic(req, res, pathname) {
  var rel = pathname === "/" ? "/index.html" : pathname;
  if (isBlocked(rel)) {
    qoder.sendJSON(res, 403, { error: { message: "forbidden" } });
    return;
  }
  var filePath = path.normalize(path.join(STATIC_ROOT, rel));
  // 防目录穿越：必须仍位于站点根目录内
  if (filePath.indexOf(STATIC_ROOT) !== 0) {
    qoder.sendJSON(res, 403, { error: { message: "forbidden" } });
    return;
  }
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      qoder.sendJSON(res, 404, { error: { message: "not_found" } });
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

var server = http.createServer(function (req, res) {
  var parsed = new URL(req.url, "http://localhost");
  var pathname = decodeURIComponent(parsed.pathname);

  if (req.method === "POST" && pathname === "/api/chat/session") {
    return qoder.handleCreateSession(req, res);
  }
  if (req.method === "POST" && pathname === "/api/chat/message") {
    return qoder.handleSendMessage(req, res);
  }
  if (req.method === "GET" && pathname === "/api/chat/stream") {
    return qoder.handleStream(req, res, parsed.searchParams);
  }
  if (req.method === "GET" && pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res, pathname);
  }
  qoder.sendJSON(res, 405, { error: { message: "method_not_allowed" } });
});

server.listen(PORT, function () {
  console.log("portal-rag-assistant (NEXLI site) running at http://localhost:" + PORT + "/");
});
