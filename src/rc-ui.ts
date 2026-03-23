/** Inline HTML/CSS/JS for the Remote Connect web UI — mobile-first, dark theme */
export function getRcHtml(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>VEEPEE Code — Remote</title>
<style>
:root {
  --brand: #E8A87C;
  --accent: #85C7F2;
  --bg: #1A1A2E;
  --surface: #252540;
  --surface2: #2A2A4A;
  --text: #FFFFFF;
  --text-dim: #888888;
  --text-dimmer: #555555;
  --success: #7EC8A0;
  --error: #E57373;
  --warning: #FFD93D;
  --border: #555555;
  --radius: 8px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  background: var(--bg);
  color: var(--text);
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ─── Auth Screen ─── */
#auth-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100dvh;
  gap: 16px;
  padding: 20px;
}
#auth-screen h1 { color: var(--brand); font-size: 1.4em; }
#auth-screen input {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 12px 16px;
  border-radius: var(--radius);
  font-size: 16px;
  width: 100%;
  max-width: 300px;
  text-align: center;
}
#auth-screen button {
  background: var(--accent);
  color: var(--bg);
  border: none;
  padding: 12px 32px;
  border-radius: var(--radius);
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
}
#auth-error { color: var(--error); font-size: 0.85em; display: none; }

/* ─── Main Layout ─── */
#app { display: none; flex-direction: column; height: 100dvh; }

/* Header */
header {
  background: var(--surface);
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
header .logo { color: var(--brand); font-weight: bold; font-size: 1.1em; }
header .status { color: var(--success); font-size: 0.8em; }
header select {
  background: var(--surface2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 0.85em;
}

/* Messages */
#messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}

.msg {
  max-width: 90%;
  padding: 10px 14px;
  border-radius: var(--radius);
  font-size: 0.9em;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.user {
  align-self: flex-end;
  background: var(--surface2);
  border-left: 3px solid var(--accent);
  color: var(--text);
}
.msg.assistant {
  align-self: flex-start;
  background: var(--surface);
  color: var(--text);
}
.msg.system {
  align-self: center;
  color: var(--text-dim);
  font-size: 0.8em;
  padding: 4px 8px;
}
.msg.tool-call {
  align-self: flex-start;
  background: transparent;
  color: var(--brand);
  font-size: 0.8em;
  padding: 4px 8px;
  border-left: 2px solid var(--brand);
}
.msg.tool-result {
  align-self: flex-start;
  font-size: 0.8em;
  padding: 4px 8px;
  color: var(--text-dim);
}
.msg.tool-result.success { border-left: 2px solid var(--success); }
.msg.tool-result.error { border-left: 2px solid var(--error); }
.msg.error {
  align-self: center;
  color: var(--error);
  font-size: 0.85em;
}

/* Permission Card */
.permission-card {
  background: var(--surface2);
  border: 1px solid var(--warning);
  border-radius: var(--radius);
  padding: 12px;
  margin: 8px 0;
}
.permission-card .tool-name { color: var(--warning); font-weight: bold; }
.permission-card .args { color: var(--text-dim); font-size: 0.85em; margin: 6px 0; }
.permission-card .actions { display: flex; gap: 8px; margin-top: 8px; }
.permission-card button {
  flex: 1;
  padding: 8px;
  border: none;
  border-radius: 4px;
  font-size: 0.9em;
  font-weight: bold;
  cursor: pointer;
}
.permission-card .btn-approve { background: var(--success); color: var(--bg); }
.permission-card .btn-always { background: var(--accent); color: var(--bg); }
.permission-card .btn-deny { background: var(--error); color: var(--text); }

/* Streaming indicator */
.streaming-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: var(--accent);
  border-radius: 50%;
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }

/* Quick Action Bar */
#quick-actions {
  background: var(--surface);
  padding: 6px 16px;
  display: flex;
  gap: 6px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
#quick-actions button {
  flex: 1;
  background: var(--surface2);
  color: var(--text-dim);
  border: 1px solid var(--border);
  padding: 8px 4px;
  border-radius: var(--radius);
  font-size: 0.85em;
  font-family: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 36px;
}
#quick-actions button:active {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
#quick-actions button.danger:active {
  background: var(--error);
  border-color: var(--error);
}

/* Input Area */
#input-area {
  background: var(--surface);
  padding: 8px 16px 12px;
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
#input-area textarea {
  flex: 1;
  background: var(--surface2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 10px 12px;
  border-radius: var(--radius);
  font-size: 16px;
  font-family: inherit;
  resize: none;
  min-height: 44px;
  max-height: 120px;
}
#input-area textarea:focus { outline: none; border-color: var(--accent); }
#input-area button {
  background: var(--accent);
  color: var(--bg);
  border: none;
  padding: 10px 16px;
  border-radius: var(--radius);
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  flex-shrink: 0;
}
#input-area button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>

<!-- Auth Screen -->
<div id="auth-screen">
  <h1>VEEPEE Code</h1>
  <p style="color: var(--text-dim)">Enter API token to connect</p>
  <input type="password" id="token-input" placeholder="API Token" autocomplete="off">
  <button onclick="authenticate()">Connect</button>
  <p id="auth-error">Invalid token</p>
</div>

<!-- Main App -->
<div id="app">
  <header>
    <span class="logo">VEEPEE Code</span>
    <select id="session-picker" onchange="switchSession(this.value)">
      <option value="">New conversation</option>
    </select>
    <span class="status" id="status-dot">Connected</span>
  </header>

  <div id="messages"></div>

  <div id="quick-actions">
    <button onclick="historyUp()" title="Previous message">&#x25B2; Prev</button>
    <button onclick="historyDown()" title="Next message">&#x25BC; Next</button>
    <button onclick="sendCommand('/compact')" title="Free context space">Compact</button>
    <button class="danger" onclick="stopGeneration()" title="Stop current generation">Stop</button>
  </div>

  <div id="input-area">
    <textarea id="msg-input" placeholder="Type a message..." rows="1"
      onkeydown="handleInputKey(event)"></textarea>
    <button id="send-btn" onclick="sendMessage()">Send</button>
  </div>
</div>

<script>
const API_BASE = window.location.origin;
let token = localStorage.getItem('vcode_rc_token') || '';
let eventSource = null;
let streaming = false;
let currentStreamEl = null;

// ─── Auth ───
function authenticate() {
  token = document.getElementById('token-input').value.trim();
  if (!token) return;

  fetch(API_BASE + '/api/status', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => {
    if (r.ok) {
      localStorage.setItem('vcode_rc_token', token);
      showApp();
    } else {
      document.getElementById('auth-error').style.display = 'block';
    }
  }).catch(() => {
    document.getElementById('auth-error').style.display = 'block';
  });
}

// Auto-login if token exists
if (token) {
  fetch(API_BASE + '/api/status', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => {
    if (r.ok) showApp();
    else document.getElementById('auth-screen').style.display = 'flex';
  }).catch(() => {
    document.getElementById('auth-screen').style.display = 'flex';
  });
} else {
  document.getElementById('auth-screen').style.display = 'flex';
}

function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  loadSessions();
  connectStream();
  document.getElementById('msg-input').focus();
}

// ─── SSE Stream ───
function connectStream() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(API_BASE + '/rc/stream?token=' + encodeURIComponent(token));

  eventSource.addEventListener('history', (e) => {
    const data = JSON.parse(e.data);
    addMessage(data.role === 'user' ? 'user' : 'assistant', data.content);
  });

  eventSource.addEventListener('text', (e) => {
    const data = JSON.parse(e.data);
    if (!currentStreamEl) {
      currentStreamEl = addMessage('assistant', '');
    }
    currentStreamEl.textContent += data.content;
    scrollToBottom();
  });

  eventSource.addEventListener('tool_call', (e) => {
    finishStream();
    const data = JSON.parse(e.data);
    const argsStr = Object.entries(data.args || {})
      .map(([k,v]) => k + '=' + (typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)))
      .join(' ');
    addMessage('tool-call', '\\u25C6 ' + data.name + ' ' + argsStr);
  });

  eventSource.addEventListener('tool_result', (e) => {
    const data = JSON.parse(e.data);
    const el = addMessage('tool-result', data.output.slice(0, 500));
    el.classList.add(data.success ? 'success' : 'error');
  });

  eventSource.addEventListener('done', () => {
    finishStream();
    streaming = false;
    document.getElementById('send-btn').disabled = false;
  });

  eventSource.addEventListener('error_event', (e) => {
    finishStream();
    const data = JSON.parse(e.data);
    addMessage('error', 'Error: ' + data.error);
    streaming = false;
    document.getElementById('send-btn').disabled = false;
  });

  eventSource.addEventListener('permission_request', (e) => {
    const data = JSON.parse(e.data);
    showPermissionCard(data);
  });

  eventSource.onerror = () => {
    document.getElementById('status-dot').textContent = 'Reconnecting...';
    document.getElementById('status-dot').style.color = 'var(--warning)';
    setTimeout(() => {
      document.getElementById('status-dot').textContent = 'Connected';
      document.getElementById('status-dot').style.color = 'var(--success)';
    }, 3000);
  };
}

function finishStream() {
  if (currentStreamEl) {
    currentStreamEl = null;
  }
}

// ─── Messages ───
function addMessage(role, content) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = content;
  document.getElementById('messages').appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  const m = document.getElementById('messages');
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

// ─── Permission Cards ───
function showPermissionCard(data) {
  const container = document.getElementById('messages');
  const card = document.createElement('div');
  card.className = 'permission-card';
  card.innerHTML =
    '<div class="tool-name">\\u26A0 ' + data.toolName + '</div>' +
    '<div class="args">' + (data.reason || '') + '</div>' +
    '<div class="args">' + JSON.stringify(data.args || {}).slice(0, 200) + '</div>' +
    '<div class="actions">' +
      '<button class="btn-approve" onclick="approvePermission(\\'' + data.callId + '\\', \\'y\\', this)">Approve</button>' +
      '<button class="btn-always" onclick="approvePermission(\\'' + data.callId + '\\', \\'a\\', this)">Always</button>' +
      '<button class="btn-deny" onclick="approvePermission(\\'' + data.callId + '\\', \\'n\\', this)">Deny</button>' +
    '</div>';
  container.appendChild(card);
  scrollToBottom();
}

function approvePermission(callId, decision, btn) {
  const card = btn.closest('.permission-card');
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  card.style.opacity = '0.6';

  fetch(API_BASE + '/rc/approve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ callId, decision }),
  });
}

// ─── Message History ───
const messageHistory = [];
let historyIndex = -1;

function historyUp() {
  if (messageHistory.length === 0) return;
  if (historyIndex < messageHistory.length - 1) historyIndex++;
  const input = document.getElementById('msg-input');
  input.value = messageHistory[messageHistory.length - 1 - historyIndex];
  input.focus();
}

function historyDown() {
  const input = document.getElementById('msg-input');
  if (historyIndex <= 0) {
    historyIndex = -1;
    input.value = '';
    input.focus();
    return;
  }
  historyIndex--;
  input.value = messageHistory[messageHistory.length - 1 - historyIndex];
  input.focus();
}

function stopGeneration() {
  // Send Ctrl+C equivalent — just send /stop as a message
  if (!streaming) return;
  fetch(API_BASE + '/rc/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ message: '/stop' }),
  }).catch(() => {});
  streaming = false;
  document.getElementById('send-btn').disabled = false;
  addMessage('system', 'Stop requested');
}

function sendCommand(cmd) {
  if (streaming) return;
  addMessage('user', cmd);
  streaming = true;
  document.getElementById('send-btn').disabled = true;
  fetch(API_BASE + '/rc/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ message: cmd }),
  }).catch(() => {
    streaming = false;
    document.getElementById('send-btn').disabled = false;
  });
}

// ─── Send Message ───
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || streaming) return;

  messageHistory.push(text);
  historyIndex = -1;
  addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  streaming = true;
  document.getElementById('send-btn').disabled = true;

  fetch(API_BASE + '/rc/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ message: text }),
  }).catch(() => {
    addMessage('error', 'Failed to send message');
    streaming = false;
    document.getElementById('send-btn').disabled = false;
  });
}

function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Auto-resize textarea
  const t = e.target;
  requestAnimationFrame(() => {
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 120) + 'px';
  });
}

// ─── Sessions ───
function loadSessions() {
  fetch(API_BASE + '/rc/sessions', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => r.json()).then(data => {
    const picker = document.getElementById('session-picker');
    picker.innerHTML = '<option value="">New conversation</option>';
    for (const s of data.sessions || []) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name + ' (' + s.messageCount + ' msgs)';
      picker.appendChild(opt);
    }
  }).catch(() => {});
}

function switchSession(sessionId) {
  if (!sessionId) return;
  document.getElementById('messages').innerHTML = '';
  addMessage('system', 'Resuming session...');

  fetch(API_BASE + '/rc/resume', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ sessionId }),
  }).then(r => r.json()).then(data => {
    document.getElementById('messages').innerHTML = '';
    if (data.ok) {
      addMessage('system', 'Resumed: ' + (data.name || sessionId));
    }
  }).catch(() => {
    addMessage('error', 'Failed to resume session');
  });
}
</script>
</body>
</html>`;
}
