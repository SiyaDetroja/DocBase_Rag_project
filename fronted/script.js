const API = "https://docbase-hhxp.onrender.com";

const token = localStorage.getItem("token");
if (!token) {
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

function getAuthHeaders(json = true) {
  const headers = {
    Authorization: `Bearer ${token}`
  };

  if (json) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return { detail: text };
  }
}

function autoResizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 180)}px`;
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

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

    item.addEventListener("click", (event) => {
      if (event.target.classList.contains("delete-btn")) {
        return;
      }
      openChat(chat.id);
    });

    const deleteBtn = item.querySelector(".delete-btn");
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openDeleteModal(chat.id);
    });

    chatList.appendChild(item);
  });
}

function getActiveChat() {
  return state.chats.find((chat) => chat.id === state.activeChatId) || null;
}

function ensureChatShape(chat) {
  if (!chat.documents) {
    chat.documents = [];
  }
  if (!chat.messages) {
    chat.messages = [];
  }
  return chat;
}

function renderMessages(chat) {
  chatBox.innerHTML = "";

  if (!chat || !chat.messages.length) {
    if (chat && chat.documents && chat.documents.length) {
      chat.documents.forEach((document) => appendDocument(document));
    } else if (emptyState) {
      chatBox.appendChild(emptyState);
    }
    return;
  }

  if (chat.documents && chat.documents.length) {
    chat.documents.forEach((document) => appendDocument(document));
  }

  chat.messages.forEach((message) => {
    appendMessage(message.role, message.content, {
      timestamp: message.timestamp
    });
  });

  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendDocument(uploadedDoc) {
  const row = document.createElement("div");
  row.className = "document-row";

  const extension = (uploadedDoc.name.split(".").pop() || "DOC").slice(0, 4).toUpperCase();
  row.innerHTML = `
    <div class="document-chip">
      <div class="document-chip-badge">${escapeHtml(extension)}</div>
      <div class="document-chip-copy">
        <p class="document-chip-title" title="${escapeHtml(uploadedDoc.name)}">${escapeHtml(uploadedDoc.name)}</p>
        <p class="document-chip-subtitle">${escapeHtml(`Uploaded: ${uploadedDoc.name}`)}</p>
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

  const extension = (fileName.split(".").pop() || "DOC").slice(0, 4).toUpperCase();
  row.innerHTML = `
    <div class="document-chip document-chip-uploading">
      <div class="document-chip-badge">${escapeHtml(extension)}</div>
      <div class="document-chip-copy">
        <p class="document-chip-title" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</p>
        <p class="document-chip-subtitle">Uploading document...</p>
      </div>
      <div class="document-loader" aria-label="Uploading document">
        <span class="document-loader-dot"></span>
        <span class="document-loader-dot"></span>
        <span class="document-loader-dot"></span>
      </div>
    </div>
  `;

  if (emptyState && emptyState.parentNode === chatBox) {
    emptyState.remove();
  }

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

function showBanner(message) {
  const banner = document.createElement("div");
  banner.className = "system-banner";
  banner.textContent = message;
  chatBox.appendChild(banner);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function clearSystemBanners() {
  chatBox.querySelectorAll(".system-banner").forEach((banner) => banner.remove());
}

function openDeleteModal(chatId) {
  pendingDeleteChatId = chatId;
  deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  pendingDeleteChatId = null;
  deleteModal.classList.add("hidden");
}

function syncUserBadge() {
  const storedUser = localStorage.getItem("user");
  if (!storedUser) {
    return;
  }

  try {
    const user = JSON.parse(storedUser);
    userBadge.textContent = user.username || user.email || "Authenticated";
  } catch (error) {
    userBadge.textContent = "Authenticated";
  }
}

function clearChatSessionState() {
  sessionStorage.removeItem("activeChatId");
}

function openSidebar() {
  document.body.classList.add("mobile-sidebar-open");
}

function closeSidebar() {
  document.body.classList.remove("mobile-sidebar-open");
}

function syncSidebarState() {
  if (window.innerWidth > 980) {
    closeSidebar();
  }
}

function restoreActiveChatState() {
  const savedChatId = sessionStorage.getItem("activeChatId");
  if (!savedChatId) {
    return;
  }

  const parsedId = Number(savedChatId);
  if (!Number.isNaN(parsedId) && parsedId > 0) {
    state.activeChatId = parsedId;
  }
}

async function createEmptyChat() {
  const response = await fetch(`${API}/chats`, {
    method: "POST",
    headers: getAuthHeaders(true),
    body: JSON.stringify({ title: "New Chat" })
  });

  const data = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(data.detail || "Could not create chat.");
  }

  const chat = ensureChatShape(data.chat);
  state.activeChatId = chat.id;
  sessionStorage.setItem("activeChatId", String(chat.id));
  state.chats.unshift(chat);
  renderChats();
  updateChatView(chat);
  return chat;
}

async function fetchHistory() {
  const response = await fetch(`${API}/history`, {
    headers: getAuthHeaders(false)
  });

  if (response.status === 401) {
    logout();
    return;
  }

  const data = await parseResponseBody(response);
  state.chats = (data.chats || []).map((chat) => ensureChatShape(chat));
  clearSystemBanners();

  if (state.activeChatId) {
    const stillExists = state.chats.some((chat) => chat.id === state.activeChatId);
    if (!stillExists) {
      state.activeChatId = null;
      clearChatSessionState();
    }
  }

  if (!state.activeChatId && state.chats.length) {
    state.activeChatId = state.chats[0].id;
    sessionStorage.setItem("activeChatId", String(state.activeChatId));
  }

  renderChats();
  const activeChat = getActiveChat();
  updateChatView(activeChat || null);
}

function updateChatView(chat) {
  chatTitle.textContent = chat ? chat.title : "New Chat";
  const hasContent = Boolean(chat && ((chat.messages && chat.messages.length) || (chat.documents && chat.documents.length)));
  chatLayout.classList.toggle("new-chat-mode", !hasContent);
  renderMessages(chat);
}

function openChat(chatId) {
  state.activeChatId = chatId;
  sessionStorage.setItem("activeChatId", String(chatId));
  renderChats();
  const chat = getActiveChat();
  updateChatView(chat);
  if (window.innerWidth <= 980) {
    closeSidebar();
  }
}

async function newChat() {
  try {
    await createEmptyChat();
  } catch (error) {
    showBanner(error.message || "Could not create a new chat.");
  }
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || state.loading) {
    return;
  }

  state.loading = true;
  if (emptyState && emptyState.parentNode === chatBox) {
    emptyState.remove();
  }

  appendMessage("user", message, { timestamp: new Date().toISOString() });
  messageInput.value = "";
  autoResizeTextarea();

  const typingNode = appendMessage("assistant", "", { typing: true });

  try {
    const response = await fetch(`${API}/chat`, {
      method: "POST",
      headers: getAuthHeaders(true),
      body: JSON.stringify({
        message,
        chat_id: state.activeChatId
      })
    });

    const data = await parseResponseBody(response);
    typingNode.remove();

    if (!response.ok) {
      console.error("[CHAT_RESPONSE_ERROR]", data);
      showBanner(data.detail || "Request failed.");
      return;
    }

    state.activeChatId = data.chat_id;
    sessionStorage.setItem("activeChatId", String(data.chat_id));
    const existingIndex = state.chats.findIndex((chat) => chat.id === data.chat_id);
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
    console.error("[CHAT_REQUEST_FAILED]", error);
    typingNode.remove();
    showBanner(`Chat request failed: ${error.message}`);
  } finally {
    state.loading = false;
  }
}

async function uploadSelectedFile() {
  const file = fileInput.files[0];
  if (!file) {
    return;
  }

  let activeChat = getActiveChat();
  if (!state.activeChatId) {
    try {
      activeChat = await createEmptyChat();
    } catch (error) {
      uploadStatus.textContent = error.message || "Could not create a chat for upload.";
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

    const existingIndex = state.chats.findIndex((chat) => chat.id === activeChat.id);
    if (existingIndex >= 0) {
      state.chats[existingIndex] = activeChat;
    } else {
      state.chats.unshift(activeChat);
    }
  }

  console.log("[UPLOAD] currentChatId before upload:", state.activeChatId, "filename:", file.name);
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
    if (!response.ok) {
      console.error("[UPLOAD_RESPONSE_ERROR]", data);
      uploadingNode.remove();
      updateChatView(activeChat);
      uploadStatus.textContent = data.detail || "Upload failed.";
      return;
    }

    console.log("[UPLOAD] backend response chat_id:", data.chat_id, "filename:", data.filename);
    uploadingNode.remove();
    uploadStatus.textContent = `${data.filename} uploaded successfully. Indexed ${data.chunks_indexed} chunks.`;
    activeChat.documents = activeChat.documents || [];
    activeChat.documents.push(data.document);
    activeChat.updated_at = new Date().toISOString();
    renderChats();
    updateChatView(activeChat);
  } catch (error) {
    console.error("[UPLOAD_REQUEST_FAILED]", error);
    uploadingNode.remove();
    updateChatView(activeChat);
    uploadStatus.textContent = "Upload failed. Check the backend server.";
  } finally {
    fileInput.value = "";
  }
}

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

  state.chats = state.chats.filter((chat) => chat.id !== chatId);

  if (!state.activeChatId && state.chats.length) {
    state.activeChatId = state.chats[0].id;
    sessionStorage.setItem("activeChatId", String(state.activeChatId));
  }

  renderChats();
  updateChatView(getActiveChat() || null);
}

function logout() {
  clearChatSessionState();
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  window.location.href = "login.html";
}

document.getElementById("sendBtn").addEventListener("click", sendMessage);
document.getElementById("newChatBtn").addEventListener("click", newChat);
document.getElementById("logoutBtn").addEventListener("click", logout);
document.getElementById("composerUploadBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", uploadSelectedFile);
if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener("click", openSidebar);
}
if (sidebarCloseBtn) {
  sidebarCloseBtn.addEventListener("click", closeSidebar);
}
if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener("click", closeSidebar);
}
confirmDeleteBtn.addEventListener("click", async () => {
  if (pendingDeleteChatId == null) {
    closeDeleteModal();
    return;
  }

  const chatId = pendingDeleteChatId;
  closeDeleteModal();
  await deleteChat(chatId);
});
cancelDeleteBtn.addEventListener("click", closeDeleteModal);
deleteModal.addEventListener("click", (event) => {
  if (event.target === deleteModal) {
    closeDeleteModal();
  }
});
quickActions.querySelectorAll(".quick-action-btn").forEach((button) => {
  button.addEventListener("click", () => {
    messageInput.value = button.dataset.prompt || "";
    autoResizeTextarea();
    messageInput.focus();
  });
});

messageInput.addEventListener("input", autoResizeTextarea);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
window.addEventListener("resize", syncSidebarState);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSidebar();
    closeDeleteModal();
  }
});

syncUserBadge();
autoResizeTextarea();
restoreActiveChatState();
syncSidebarState();
fetchHistory().catch(() => {
  clearSystemBanners();
  showBanner("Backend is restarting or temporarily unavailable. Retrying...");
  clearTimeout(historyRetryTimer);
  historyRetryTimer = setTimeout(() => {
    fetchHistory().catch(() => { });
  }, 1500);
});
