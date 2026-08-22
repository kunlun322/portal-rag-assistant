/* ============================================================
   portal-rag-assistant — 蔚小理汽车 NEXLI 官网 · 在线客服组件（接入 Qoder Cloud Agents 知识库问答）
   4 个页面共用：悬浮按钮 + Agent 风格对话框
   所有 Qoder API 调用均经本站服务端代理（/api/chat/*），前端不含任何密钥
   ============================================================ */
(function () {
  "use strict";

  var QUICK_QUESTIONS = [
    "小鹏 P7 要保养哪些项目？",
    "冬季续航下降该怎么应对？",
    "电池日常养护有哪些技巧？"
  ];

  var ERROR_TEXT = "服务暂时繁忙，请稍后再试";
  var TURN_TIMEOUT_MS = 90000; // 90 秒无任何事件 → 判定超时，避免卡死 loading
  var TYPING_HINTS = [
    "消息已收到",
    "正在努力查询",
    "请稍后",
    "正在为您检索资料…",
    "即将为您整理答案…"
  ];
  var TYPING_HINT_INTERVAL_MS = 3000; // 轮播间隔：需求范围 2–4 秒

  var ICON_CHAT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/>' +
    '<path d="M8.5 11h.01M12 11h.01M15.5 11h.01"/></svg>';

  var ICON_BOT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="7" width="16" height="12" rx="3"/>' +
    '<path d="M12 7V4M9 4h6"/>' +
    '<path d="M9 12h.01M15 12h.01"/>' +
    '<path d="M9.5 15.5c1.5 1 3.5 1 5 0"/></svg>';

  /* ---------- 会话状态（内存级：刷新页面重置，不做持久化） ---------- */
  var sessionId = null;
  var eventSource = null;
  var busy = false; // 本轮回答进行中：禁用发送，避免 409 turn_already_running
  var welcomed = false;
  var turnText = ""; // 本轮累计的 Agent 回答文本
  var typingRow = null;
  var hintTimer = null; // 等待轮播提示文字的定时器
  var streamBubble = null; // 本轮流式渲染的气泡
  var turnTimer = null;
  var seenEventIds = []; // 幂等消费：按 Event ID 去重（SSE 断线重连续传）
  var pendingText = null; // 等待补发的消息（session 重建 / 上一轮未结束）

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  /* ---------- 构建悬浮按钮 ---------- */

  var fab = el("button", "cs-fab");
  fab.type = "button";
  fab.setAttribute("aria-label", "打开在线客服");
  fab.innerHTML = ICON_CHAT;
  fab.appendChild(el("span", null, "在线客服"));
  document.body.appendChild(fab);

  /* ---------- 构建对话面板 ---------- */

  var panel = el("div", "cs-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "蔚小理智能助手对话框");

  var header = el("div", "cs-panel__header");
  var avatar = el("div", "cs-panel__avatar");
  avatar.innerHTML = ICON_BOT;
  var headerInfo = el("div", "cs-panel__info");
  headerInfo.appendChild(el("p", "cs-panel__name", "蔚小理智能助手"));
  headerInfo.appendChild(el("p", "cs-panel__status", "在线"));
  var closeBtn = el("button", "cs-panel__close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭对话框");
  closeBtn.textContent = "×";
  header.appendChild(avatar);
  header.appendChild(headerInfo);
  header.appendChild(closeBtn);

  var messagesBox = el("div", "cs-messages");

  /* 快捷提问独立区：位于消息流与输入框之间，不挤占对话文字空间；
     用户发出首条消息后整体收起 */
  var quickBar = el("div", "cs-quickbar");
  quickBar.appendChild(el("p", "cs-quickbar__title", "大家都在问"));
  var quickChips = el("div", "cs-quickbar__chips");
  QUICK_QUESTIONS.forEach(function (q) {
    var btn = el("button", "cs-quickbar__btn", q);
    btn.type = "button";
    btn.addEventListener("click", function () {
      sendUserMessage(q);
    });
    quickChips.appendChild(btn);
  });
  quickBar.appendChild(quickChips);

  var inputBar = el("div", "cs-input");
  var inputField = document.createElement("input");
  inputField.className = "cs-input__field";
  inputField.type = "text";
  inputField.placeholder = "请输入您的问题…";
  inputField.setAttribute("aria-label", "输入消息");
  var sendBtn = el("button", "cs-input__send", "发送");
  sendBtn.type = "button";
  inputBar.appendChild(inputField);
  inputBar.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(messagesBox);
  panel.appendChild(quickBar);
  panel.appendChild(inputBar);
  document.body.appendChild(panel);

  /* ---------- Markdown 轻量渲染（marked + 白名单净化） ---------- */

  var ALLOWED_TAGS = {
    P: 1, BR: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1,
    UL: 1, OL: 1, LI: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, PRE: 1, CODE: 1, HR: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1,
    A: 1, SPAN: 1
  };

  function sanitizeNode(node) {
    var children = Array.prototype.slice.call(node.childNodes);
    children.forEach(function (child) {
      if (child.nodeType === 1) {
        var tag = child.tagName;
        if (!ALLOWED_TAGS[tag]) {
          // 不允许的标签：只保留其文本内容
          node.replaceChild(document.createTextNode(child.textContent || ""), child);
          return;
        }
        // 清理属性：仅允许 <a> 的 http/https href
        Array.prototype.slice.call(child.attributes).forEach(function (attr) {
          var name = attr.name.toLowerCase();
          if (tag === "A" && name === "href") {
            var v = (attr.value || "").trim().toLowerCase();
            if (v.indexOf("http://") !== 0 && v.indexOf("https://") !== 0) {
              child.removeAttribute(attr.name);
              return;
            }
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noopener noreferrer");
            return;
          }
          child.removeAttribute(attr.name);
        });
        sanitizeNode(child);
      } else if (child.nodeType !== 3) {
        node.removeChild(child); // 移除注释等非文本节点
      }
    });
  }

  function renderMarkdown(text) {
    if (window.marked) {
      try {
        var html = window.marked.parse(text, { breaks: true, gfm: true });
        var holder = document.createElement("div");
        holder.innerHTML = html;
        sanitizeNode(holder);
        return holder.innerHTML;
      } catch (e) { /* 解析失败则降级为纯文本 */ }
    }
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, "<br>");
  }

  /* ---------- 消息渲染 ---------- */

  function scrollToBottom() {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  function renderUserMessage(text) {
    var row = el("div", "cs-msg cs-msg--user");
    row.appendChild(el("div", "cs-msg__bubble", text));
    messagesBox.appendChild(row);
    scrollToBottom();
  }

  function renderErrorBubble() {
    var row = el("div", "cs-msg cs-msg--bot");
    var bubble = el("div", "cs-msg__bubble cs-msg__bubble--error", ERROR_TEXT);
    var retry = el("button", "cs-retry", "重试");
    retry.type = "button";
    retry.addEventListener("click", function () {
      row.remove();
      if (pendingText) {
        var t = pendingText;
        pendingText = null;
        sendUserMessage(t);
      }
    });
    bubble.appendChild(document.createTextNode(" "));
    bubble.appendChild(retry);
    row.appendChild(bubble);
    messagesBox.appendChild(row);
    scrollToBottom();
  }

  function renderWelcome() {
    var row = el("div", "cs-msg cs-msg--bot");
    row.appendChild(
      el(
        "div",
        "cs-msg__bubble",
        "您好，我是蔚小理智能助手，很高兴为您服务。\n您可以点击下方的推荐问题，或直接输入想咨询的内容。"
      )
    );
    messagesBox.appendChild(row);
    scrollToBottom();
  }

  function hideQuickQuestions() {
    quickBar.classList.add("cs-quickbar--hidden");
  }

  function startHintCarousel(hintEl) {
    var index = 0;
    hintEl.textContent = TYPING_HINTS[0];
    hintTimer = setInterval(function () {
      hintEl.classList.add("cs-typing__hint--fade");
      setTimeout(function () {
        index = (index + 1) % TYPING_HINTS.length;
        hintEl.textContent = TYPING_HINTS[index];
        hintEl.classList.remove("cs-typing__hint--fade");
      }, 250); // 与 CSS 淡出时长一致
    }, TYPING_HINT_INTERVAL_MS);
  }

  function stopHintCarousel() {
    if (hintTimer) {
      clearInterval(hintTimer);
      hintTimer = null;
    }
  }

  function showTyping() {
    hideTyping();
    typingRow = el("div", "cs-msg cs-msg--bot");
    var bubble = el("div", "cs-msg__bubble cs-typing");
    bubble.appendChild(el("span"));
    bubble.appendChild(el("span"));
    bubble.appendChild(el("span"));
    var hint = el("span", "cs-typing__hint");
    bubble.appendChild(hint);
    typingRow.appendChild(bubble);
    messagesBox.appendChild(typingRow);
    scrollToBottom();
    startHintCarousel(hint);
  }

  function hideTyping() {
    stopHintCarousel();
    if (typingRow) {
      typingRow.remove();
      typingRow = null;
    }
  }

  function ensureStreamBubble() {
    if (streamBubble) return streamBubble;
    hideTyping();
    var row = el("div", "cs-msg cs-msg--bot");
    streamBubble = el("div", "cs-msg__bubble cs-msg__bubble--md cs-streaming");
    row.appendChild(streamBubble);
    messagesBox.appendChild(row);
    return streamBubble;
  }

  function renderStreamText() {
    var bubble = ensureStreamBubble();
    bubble.innerHTML = renderMarkdown(turnText);
    scrollToBottom();
  }

  /* ---------- 输入状态 ---------- */

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    inputField.disabled = value;
    sendBtn.classList.toggle("cs-disabled", value);
    inputField.classList.toggle("cs-disabled", value);
  }

  function finishTurn() {
    clearTurnTimer();
    hideTyping();
    if (streamBubble) streamBubble.classList.remove("cs-streaming");
    streamBubble = null;
    turnText = "";
    setBusy(false);
  }

  function failTurn() {
    finishTurn();
    renderErrorBubble();
  }

  /* ---------- 超时控制：90 秒无任何事件 → 友好报错 ---------- */

  function clearTurnTimer() {
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
    }
  }

  function armTurnTimer() {
    clearTurnTimer();
    turnTimer = setTimeout(function () {
      if (busy) {
        pendingText = pendingText || null;
        failTurn();
      }
    }, TURN_TIMEOUT_MS);
  }

  /* ---------- SSE 事件流 ---------- */

  function isDuplicate(eventId) {
    if (!eventId) return false;
    if (seenEventIds.indexOf(eventId) !== -1) return true;
    seenEventIds.push(eventId);
    if (seenEventIds.length > 500) seenEventIds.shift();
    return false;
  }

  function openStream(id) {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    var es = new EventSource("/api/chat/stream?session_id=" + encodeURIComponent(id));
    eventSource = es;

    // 注意：同一轮回答的所有 event_delta 帧共用同一个 Event ID，
    // 因此增量帧不做按 ID 去重（重连导致的少量重复会由 agent.message 全量文本纠正）；
    // 离散事件（agent.message / session.status_idle）仍按 Event ID 幂等消费。
    function onFrame(e, dedupe) {
      if (dedupe && isDuplicate(e.lastEventId)) return false;
      if (busy) armTurnTimer(); // 有事件到达即视为活跃，重置超时计时
      return true;
    }

    es.addEventListener("event_delta", function (e) {
      if (!onFrame(e, false) || !busy) return;
      try {
        var data = JSON.parse(e.data);
        var delta = data && data.delta;
        var text = delta && delta.content && delta.content.text;
        if (typeof text === "string" && text) {
          turnText += text;
          renderStreamText();
        }
      } catch (err) { /* 忽略无法解析的帧 */ }
    });

    es.addEventListener("agent.message", function (e) {
      if (!onFrame(e, true) || !busy) return;
      try {
        var data = JSON.parse(e.data);
        var content = data && data.content;
        var text = "";
        if (Array.isArray(content)) {
          content.forEach(function (part) {
            if (part && part.type === "text" && typeof part.text === "string") {
              text += part.text;
            }
          });
        }
        if (text) {
          // agent.message 为该条回答的完整文本：作为校对/兜底覆盖增量拼接结果
          turnText = text;
          renderStreamText();
        }
      } catch (err) { /* 忽略无法解析的帧 */ }
    });

    es.addEventListener("session.status_idle", function (e) {
      if (!onFrame(e, true) || !busy) return;
      var hadAnswer = !!turnText;
      finishTurn();
      if (!hadAnswer) {
        renderErrorBubble();
        return;
      }
      if (pendingText) {
        var t = pendingText;
        pendingText = null;
        sendUserMessage(t);
      }
    });

    // 连接异常交由 EventSource 自动重连（浏览器携带 Last-Event-ID 续传）
  }

  /* ---------- 服务端代理调用 ---------- */

  function createSession(cb) {
    fetch("/api/chat/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "蔚小理官网客服对话" })
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (r) {
        if (r.ok && r.body && r.body.id) {
          sessionId = r.body.id;
          seenEventIds = [];
          openStream(sessionId);
          cb(null);
        } else {
          cb(new Error("create_session_failed"));
        }
      })
      .catch(function () {
        cb(new Error("network_error"));
      });
  }

  function postMessage(text, cb) {
    fetch("/api/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, text: text })
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (r) {
        cb(null, r);
      })
      .catch(function () {
        cb(new Error("network_error"));
      });
  }

  function isSessionGone(r) {
    if (r.status === 404) return true;
    var code = r.body && r.body.error && r.body.error.code;
    return r.status === 409 && code === "session_archived";
  }

  function dispatchMessage(text, retried) {
    postMessage(text, function (err, r) {
      if (err) {
        failTurn();
        return;
      }
      if (r.ok) {
        armTurnTimer();
        return;
      }
      if (isSessionGone(r) && !retried) {
        // session 失效：重建一次并重试
        sessionId = null;
        createSession(function (err2) {
          if (err2) {
            failTurn();
            return;
          }
          dispatchMessage(text, true);
        });
        return;
      }
      if (r.status === 409) {
        // 上一轮回答仍在进行：等待 idle 后自动补发
        pendingText = text;
        armTurnTimer();
        return;
      }
      failTurn();
    });
  }

  /* ---------- 发送入口 ---------- */

  function sendUserMessage(text) {
    text = (text || "").trim();
    if (!text || busy) return;

    hideQuickQuestions();
    renderUserMessage(text);
    setBusy(true);
    pendingText = text;
    showTyping();

    if (!sessionId) {
      createSession(function (err) {
        if (err) {
          failTurn();
          return;
        }
        pendingText = null;
        dispatchMessage(text, false);
      });
    } else {
      pendingText = null;
      dispatchMessage(text, false);
    }
  }

  /* ---------- 开关逻辑 ---------- */

  function openPanel() {
    if (!welcomed) {
      welcomed = true;
      renderWelcome();
    }
    panel.classList.add("cs-open");
    fab.classList.add("cs-hidden");
    inputField.focus();
  }

  function closePanel() {
    panel.classList.remove("cs-open");
    fab.classList.remove("cs-hidden");
  }

  fab.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);

  function submitInput() {
    var text = inputField.value.trim();
    if (!text) return;
    inputField.value = "";
    sendUserMessage(text);
  }

  sendBtn.addEventListener("click", submitInput);
  inputField.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitInput();
    }
  });
})();
