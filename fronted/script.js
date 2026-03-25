const API = "https://docbase-hhxp.onrender.com";

if (!localStorage.getItem("token")) {
  window.location.href = "login.html";
}

const state = {
  chats: [],
  activeChatId: null,
  loading: false
};

const chatList = document.getElementById("chatList");
const chatBox = document.getElementById("chatBox");
const chatTitle = document.getElementById("chatTitle");
const messageInput = document.getElementById("messageInput");
const fileInput = document.getElementById("fileInput");
const uploadStatus = document.getElementById("uploadStatus");
const emptyState = document.getElementById("emptyState");
const userBadge = document.getElementById("userBadge");
const chatLayout = document.querySelector(".chat-layout");
const quickActions = document.getElementById("quickActions");
const deleteModal = document.getElementById("deleteModal");
const confirmDeleteBtn = document.getElementById("confirmDeleteBtn");
const cancelDeleteBtn = document.getElementById("cancelDeleteBtn");
const mobileMenuBtn = document.getElementById("mobileMenuBtn");
const sidebarCloseBtn = document.getElementById("sidebarCloseBtn");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
let historyRetryTimer = null;
let pendingDeleteChatId = null;

// ─────────────────────────────────────────────────────────────
// Keep Render free tier awake — ping every 10 minutes
// ─────────────────────────────────────────────────────────────
setInterval(() => {
  fetch(`${API}/`).catch(() => {});
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// Token helpers
// ─────────────────────────────────────────────────────────────
function getAuthHeaders(json = true) {
  const token = localStorage.getItem("token");
  const headers = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * Check if the stored JWT is expired BEFORE sending a request.
 * JWT payload is base64url — we just decode the middle part.
 */
function isTokenExpired() {
  const token = localStorage.getItem("token");
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    // exp is in seconds — compare to current time
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

function handleExpiredToken() {
  showBanner("Your session has expired. Please log in again.");
  setTimeout(() => {
    logout();
  }, 2000);
}

// ─────────────────────────────────────────────────────────────
// Response parser
// ─────────────────────────────────────────────────────────────
async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
}

// ─────────────────────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────────────────────
function autoResizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function showBanner(message) {
  const banner = document.createElement("div");
  banner.className = "system-banner";
  banner.textContent = message;
  chatBox.appendChild(banner);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function clearSystemBanners() {
  chatBox.querySelectorAll(".system-banner").forEach((b) => b.remove());
}

// ─────────────────────────────────────────────────────────────
// Chat list rendering
// ─────────────────────────────────────────────────────────────
function renderChats() {
  chatList.innerHTML = "";
  if (!state.chats.length) {
    chatList.innerHTML = '<div class="chat-item empty-chat-item"><h3>New chats will appear here</h3></div>';
    return;
  }
  state.chats.forEach((chat) => {
    const item = document.createElement("div");
    const title = (chat.title || "New Chat").trim();
    item.className = `chat-item${chat.id === state.activeChatId ? " active" : ""}`;
    item.innerHTML = `
      <div class="chat-item-head">
        <h3 title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
        <button class="delete-btn" type="button" data-chat-id="${chat.id}">Delete</button>
      </div>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("delete-btn")) return;
      openChat(chat.id);
    });
    item.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteModal(chat.id);
    });
    chatList.appendChild(item);
  });
}

function getActiveChat() {
  return state.chats.find((c) => c.id === state.activeChatId) || null;
}

function ensureChatShape(chat) {
  if (!chat.documents) chat.documents = [];
  if (!chat.messages) chat.messages = [];
  return chat;
}

// ─────────────────────────────────────────────────────────────
// Message / document rendering
// ─────────────────────────────────────────────────────────────
function renderMessages(chat) {
  chatBox.innerHTML = "";
  if (!chat || !chat.messages.length) {
    if (chat && chat.documents && chat.documents.length) {
      chat.documents.forEach(appendDocument);
    } else if (emptyState) {
      chatBox.appendChild(emptyState);
    }
    return;
  }
  if (chat.documents && chat.documents.length) {
    chat.documents.forEach(appendDocument);
  }
  chat.messages.forEach((m) => appendMessage(m.role, m.content, { timestamp: m.timestamp }));
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendDocument(uploadedDoc) {
  const row = document.createElement("div");
  row.className = "document-row";
  const ext = (uploadedDoc.name.split(".").pop() || "DOC").slice(0, 4).toUpperCase();
  row.innerHTML = `
    <div class="document-chip">
      <div class="document-chip-badge">${escapeHtml(ext)}</div>
      <div class="document-chip-copy">
        <p class="document-chip-title" title="${escapeHtml(uploadedDoc.name)}">${escapeHtml(uploadedDoc.name)}</p>
        <p class="document-chip-subtitle">Uploaded: ${escapeHtml(uploadedDoc.name)}</p>
      </div>
    </div>
  `;
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
  return row;
}

function appendUploadingDocument(fileName) {
  const row = document.createElement("div");
  row.className = "document-row";
  const ext = (fileName.split(".").pop() || "DOC").slice(0, 4).toUpperCase();
  row.innerHTML = `
    <div class="document-chip document-chip-uploading">
      <div class="document-chip-badge">${escapeHtml(ext)}</div>
      <div class="document-chip-copy">
        <p class="document-chip-title">${escapeHtml(fileName)}</p>
        <p class="document-chip-subtitle">Uploading document...</p>
      </div>
      <div class="document-loader" aria-label="Uploading document">
        <span class="document-loader-dot"></span>
        <span class="document-loader-dot"></span>
        <span class="document-loader-dot"></span>
      </div>
    </div>
  `;
  if (emptyState && emptyState.parentNode === chatBox) emptyState.remove();
  chatLayout.classList.remove("new-chat-mode");
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
  return row;
}

function appendMessage(role, content, options = {}) {
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  const bubble = document.createElement("div");
  bubble.className = `message-bubble${role === "assistant" ? " message-content" : ""}`;
  bubble.innerHTML = escapeHtml(content);

  if (options.typing) {
    bubble.innerHTML = `
      <div class="typing">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    `;
  }

  if (options.timestamp || options.sources) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = options.timestamp ? formatTime(options.timestamp) : "";
    bubble.appendChild(meta);
    if (options.sources && options.sources.length) {
      const sources = document.createElement("div");
      sources.className = "sources";
      sources.textContent = `Sources: ${options.sources.join(", ")}`;
      bubble.appendChild(sources);
    }
  }

  row.appendChild(bubble);
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
  return row;
}

// ─────────────────────────────────────────────────────────────
// Delete modal
// ─────────────────────────────────────────────────────────────
function openDeleteModal(chatId) {
  pendingDeleteChatId = chatId;
  deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  pendingDeleteChatId = null;
  deleteModal.classList.add("hidden");
}

// ─────────────────────────────────────────────────────────────
// Sidebar (mobile)
// ─────────────────────────────────────────────────────────────
function openSidebar() { document.body.classList.add("mobile-sidebar-open"); }
function closeSidebar() { document.body.classList.remove("mobile-sidebar-open"); }
function syncSidebarState() { if (window.innerWidth > 980) closeSidebar(); }

// ─────────────────────────────────────────────────────────────
// User badge
// ─────────────────────────────────────────────────────────────
function syncUserBadge() {
  const stored = localStorage.getItem("user");
  if (!stored) return;
  try {
    const user = JSON.parse(stored);
    userBadge.textContent = user.username || user.email || "Authenticated";
  } catch {
    userBadge.textContent = "Authenticated";
  }
}

// ─────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────
function clearChatSessionState() { sessionStorage.removeItem("activeChatId"); }

function restoreActiveChatState() {
  const saved = sessionStorage.getItem("activeChatId");
  if (!saved) return;
  const id = Number(saved);
  if (!Number.isNaN(id) && id > 0) state.activeChatId = id;
}

// ─────────────────────────────────────────────────────────────
// Chat operations
// ─────────────────────────────────────────────────────────────
function updateChatView(chat) {
  chatTitle.textContent = chat ? chat.title : "New Chat";
  const hasContent = Boolean(
    chat && ((chat.messages && chat.messages.length) || (chat.documents && chat.documents.length))
  );
  chatLayout.classList.toggle("new-chat-mode", !hasContent);
  renderMessages(chat);
}

function openChat(chatId) {
  state.activeChatId = chatId;
  sessionStorage.setItem("activeChatId", String(chatId));
  renderChats();
  updateChatView(getActiveChat());
  if (window.innerWidth <= 980) closeSidebar();
}

async function createEmptyChat() {
  const response = await fetch(`${API}/chats`, {
    method: "POST",
    headers: getAuthHeaders(true),
    body: JSON.stringify({ title: "New Chat" })
  });
  const data = await parseResponseBody(response);
  if (!response.ok) throw new Error(data.detail || "Could not create chat.");
  const chat = ensureChatShape(data.chat);
  state.activeChatId = chat.id;
  sessionStorage.setItem("activeChatId", String(chat.id));
  state.chats.unshift(chat);
  renderChats();
  updateChatView(chat);
  return chat;
}

async function fetchHistory() {
  const response = await fetch(`${API}/history`, { headers: getAuthHeaders() });
  if (response.status === 401) { logout(); return; }
  const data = await parseResponseBody(response);
  state.chats = (data.chats || []).map(ensureChatShape);
  clearSystemBanners();
  if (state.activeChatId && !state.chats.some((c) => c.id === state.activeChatId)) {
    state.activeChatId = null;
    clearChatSessionState();
  }
  if (!state.activeChatId && state.chats.length) {
    state.activeChatId = state.chats[0].id;
    sessionStorage.setItem("activeChatId", String(state.activeChatId));
  }
  renderChats();
  updateChatView(getActiveChat() || null);
}

async function newChat() {
  try {
    await createEmptyChat();
  } catch (e) {
    showBanner(e.message || "Could not create a new chat.");
  }
}

// ─────────────────────────────────────────────────────────────
// sendMessage — fully fixed
// ─────────────────────────────────────────────────────────────
async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || state.loading) return;

  // ✅ Check token expiry BEFORE sending — avoids the fake CORS error
  if (isTokenExpired()) {
    handleExpiredToken();
    return;
  }

  const sendBtn = document.getElementById("sendBtn");
  sendBtn.disabled = true;
  state.loading = true;

  if (emptyState && emptyState.parentNode === chatBox) emptyState.remove();

  appendMessage("user", message, { timestamp: new Date().toISOString() });
  messageInput.value = "";
  autoResizeTextarea();

  const typingNode = appendMessage("assistant", "", { typing: true });

  try {
    const response = await fetch(`${API}/chat`, {
      method: "POST",
      headers: getAuthHeaders(true),
      body: JSON.stringify({ message, chat_id: state.activeChatId })
    });

    const data = await parseResponseBody(response);
    typingNode.remove(); // ✅ always removed after response

    // ✅ Handle 401 (expired token) properly instead of showing CORS error
    if (response.status === 401) {
      handleExpiredToken();
      return;
    }

    if (!response.ok) {
      showBanner(data.detail || "Request failed. Please try again.");
      return;
    }

    state.activeChatId = data.chat_id;
    sessionStorage.setItem("activeChatId", String(data.chat_id));

    const existingIndex = state.chats.findIndex((c) => c.id === data.chat_id);
    const existingChat = existingIndex >= 0 ? state.chats[existingIndex] : null;
    const updatedChat = ensureChatShape({
      id: data.chat_id,
      title: existingChat && existingChat.messages.length ? existingChat.title : message,
      created_at: existingChat ? existingChat.created_at : new Date().toISOString(),
      updated_at: new Date().toISOString(),
      documents: data.documents || (existingChat ? existingChat.documents : []),
      messages: data.messages || []
    });

    if (existingIndex >= 0) {
      state.chats[existingIndex] = updatedChat;
    } else {
      state.chats.unshift(updatedChat);
    }

    renderChats();
    updateChatView(updatedChat);

    // Append sources to last assistant bubble
    const rows = Array.from(chatBox.querySelectorAll(".message-row.assistant"));
    const lastRow = rows[rows.length - 1];
    if (lastRow && data.sources && data.sources.length) {
      const bubble = lastRow.querySelector(".message-bubble");
      if (bubble && !bubble.querySelector(".sources")) {
        const sources = document.createElement("div");
        sources.className = "sources";
        sources.textContent = `Sources: ${data.sources.join(", ")}`;
        bubble.appendChild(sources);
      }
    }

  } catch (error) {
    // ✅ typingNode is already removed above on success path;
    //    on network error it may still be in DOM — remove safely
    if (typingNode.parentNode) typingNode.remove();

    // Distinguish network failure from token expiry
    if (isTokenExpired()) {
      handleExpiredToken();
    } else {
      showBanner("Chat request failed. Please check your connection and try again.");
    }
    console.error("[CHAT_REQUEST_FAILED]", error);
  } finally {
    // ✅ ALWAYS re-enable the button — success, error, or 401
    state.loading = false;
    sendBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// File upload
// ─────────────────────────────────────────────────────────────
async function uploadSelectedFile() {
  const file = fileInput.files[0];
  if (!file) return;

  if (isTokenExpired()) { handleExpiredToken(); return; }

  let activeChat = getActiveChat();
  if (!state.activeChatId) {
    try {
      activeChat = await createEmptyChat();
    } catch (e) {
      uploadStatus.textContent = e.message || "Could not create a chat for upload.";
      fileInput.value = "";
      return;
    }
  }

  if (!activeChat && state.activeChatId) {
    activeChat = ensureChatShape({
      id: state.activeChatId,
      title: chatTitle.textContent || "New Chat",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      documents: [],
      messages: []
    });
    const idx = state.chats.findIndex((c) => c.id === activeChat.id);
    if (idx >= 0) state.chats[idx] = activeChat;
    else state.chats.unshift(activeChat);
  }

  uploadStatus.textContent = `Uploading ${file.name}...`;
  const uploadingNode = appendUploadingDocument(file.name);
  const formData = new FormData();
  formData.append("file", file);
  formData.append("chat_id", String(state.activeChatId));

  try {
    const response = await fetch(`${API}/upload`, {
      method: "POST",
      headers: getAuthHeaders(false),
      body: formData
    });
    const data = await parseResponseBody(response);

    if (response.status === 401) { handleExpiredToken(); return; }

    if (!response.ok) {
      uploadingNode.remove();
      updateChatView(activeChat);
      uploadStatus.textContent = data.detail || "Upload failed.";
      return;
    }

    uploadingNode.remove();
    uploadStatus.textContent = `${data.filename} uploaded. Indexed ${data.chunks_indexed} chunks.`;
    activeChat.documents = activeChat.documents || [];
    activeChat.documents.push(data.document);
    activeChat.updated_at = new Date().toISOString();
    renderChats();
    updateChatView(activeChat);
  } catch (e) {
    uploadingNode.remove();
    updateChatView(activeChat);
    uploadStatus.textContent = "Upload failed. Check your connection.";
    console.error("[UPLOAD_REQUEST_FAILED]", e);
  } finally {
    fileInput.value = "";
  }
}

// ─────────────────────────────────────────────────────────────
// Delete chat
// ─────────────────────────────────────────────────────────────
async function deleteChat(chatId) {
  const response = await fetch(`${API}/chats/${chatId}`, {
    method: "DELETE",
    headers: getAuthHeaders(false)
  });
  if (!response.ok) {
    const data = await parseResponseBody(response);
    alert(data.detail || "Could not delete chat.");
    return;
  }
  if (state.activeChatId === chatId) {
    state.activeChatId = null;
    clearChatSessionState();
  }
  state.chats = state.chats.filter((c) => c.id !== chatId);
  if (!state.activeChatId && state.chats.length) {
    state.activeChatId = state.chats[0].id;
    sessionStorage.setItem("activeChatId", String(state.activeChatId));
  }
  renderChats();
  updateChatView(getActiveChat() || null);
}

// ─────────────────────────────────────────────────────────────
// Logout
// ─────────────────────────────────────────────────────────────
function logout() {
  clearChatSessionState();
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  window.location.href = "login.html";
}

// ─────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────
document.getElementById("sendBtn").addEventListener("click", sendMessage);
document.getElementById("newChatBtn").addEventListener("click", newChat);
document.getElementById("logoutBtn").addEventListener("click", logout);
document.getElementById("composerUploadBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", uploadSelectedFile);
if (mobileMenuBtn) mobileMenuBtn.addEventListener("click", openSidebar);
if (sidebarCloseBtn) sidebarCloseBtn.addEventListener("click", closeSidebar);
if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", closeSidebar);

confirmDeleteBtn.addEventListener("click", async () => {
  if (pendingDeleteChatId == null) { closeDeleteModal(); return; }
  const chatId = pendingDeleteChatId;
  closeDeleteModal();
  await deleteChat(chatId);
});
cancelDeleteBtn.addEventListener("click", closeDeleteModal);
deleteModal.addEventListener("click", (e) => { if (e.target === deleteModal) closeDeleteModal(); });

quickActions.querySelectorAll(".quick-action-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    messageInput.value = btn.dataset.prompt || "";
    autoResizeTextarea();
    messageInput.focus();
  });
});

messageInput.addEventListener("input", autoResizeTextarea);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
window.addEventListener("resize", syncSidebarState);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSidebar(); closeDeleteModal(); }
});

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────
syncUserBadge();
autoResizeTextarea();
restoreActiveChatState();
syncSidebarState();
fetchHistory().catch(() => {
  clearSystemBanners();
  showBanner("Backend is restarting or temporarily unavailable. Retrying...");
  clearTimeout(historyRetryTimer);
  historyRetryTimer = setTimeout(() => { fetchHistory().catch(() => {}); }, 1500);
});