const API = "https://docbase-hhxp.onrender.com/";

function getValue(id) {
  const element = document.getElementById(id);
  return element ? element.value.trim() : "";
}

function getRawValue(id) {
  const element = document.getElementById(id);
  return element ? element.value : "";
}

function setButtonState(buttonId, loadingText, isLoading) {
  const button = document.getElementById(buttonId);
  if (!button) {
    return;
  }

  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent;
  }

  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : button.dataset.defaultText;
}

async function parseResponse(response) {
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

function setFieldError(fieldId, message = "") {
  const field = document.getElementById(fieldId);
  const error = document.getElementById(`${fieldId}Error`);
  if (field) {
    field.classList.toggle("is-invalid", Boolean(message));
  }
  if (error) {
    error.textContent = message;
  }
}

function clearFieldError(fieldId) {
  setFieldError(fieldId, "");
}

function clearErrors(fieldIds = []) {
  fieldIds.forEach(clearFieldError);
}

function setFormMessage(formId, message = "", kind = "error") {
  const node = document.getElementById(formId);
  if (!node) {
    return;
  }

  node.textContent = message;
  node.classList.remove("error", "success");
  if (message) {
    node.classList.add(kind);
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongPassword(password) {
  return /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function getPasswordRuleMessage() {
  return "Password must include uppercase, lowercase, number, and special character.";
}

function validateSignupForm() {
  const username = getValue("username");
  const email = getValue("email");
  const password = getRawValue("password");
  let valid = true;

  clearErrors(["username", "email", "password"]);
  setFormMessage("signupMessage", "");

  if (!username) {
    setFieldError("username", "Username is required.");
    valid = false;
  } else if (username.length < 3) {
    setFieldError("username", "Username must be at least 3 characters.");
    valid = false;
  }

  if (!email) {
    setFieldError("email", "Email is required.");
    valid = false;
  } else if (!isValidEmail(email)) {
    setFieldError("email", "Enter a valid email address.");
    valid = false;
  }

  if (!password) {
    setFieldError("password", "Password is required.");
    valid = false;
  } else if (password.length < 8) {
    setFieldError("password", "Password must be at least 8 characters.");
    valid = false;
  } else if (!isStrongPassword(password)) {
    setFieldError("password", getPasswordRuleMessage());
    valid = false;
  }

  return valid;
}

function validateLoginForm() {
  const identifier = getValue("identifier");
  const password = getRawValue("password");
  let valid = true;

  clearErrors(["identifier", "password"]);
  setFormMessage("loginMessage", "");

  if (!identifier) {
    setFieldError("identifier", "Username or email is required.");
    valid = false;
  }

  if (!password) {
    setFieldError("password", "Password is required.");
    valid = false;
  } else if (password.length < 8) {
    setFieldError("password", "Password must be at least 8 characters.");
    valid = false;
  }

  return valid;
}

function validateResetForm() {
  const identifier = getValue("resetIdentifier");
  const password = getRawValue("resetPassword");
  const confirmPassword = getRawValue("resetConfirmPassword");
  let valid = true;

  clearErrors(["resetIdentifier", "resetPassword", "resetConfirmPassword"]);
  setFormMessage("resetMessage", "");

  if (!identifier) {
    setFieldError("resetIdentifier", "Username or email is required.");
    valid = false;
  }

  if (!password) {
    setFieldError("resetPassword", "New password is required.");
    valid = false;
  } else if (password.length < 8) {
    setFieldError("resetPassword", "New password must be at least 8 characters.");
    valid = false;
  } else if (!isStrongPassword(password)) {
    setFieldError("resetPassword", getPasswordRuleMessage());
    valid = false;
  }

  if (!confirmPassword) {
    setFieldError("resetConfirmPassword", "Please confirm the new password.");
    valid = false;
  } else if (password !== confirmPassword) {
    setFieldError("resetConfirmPassword", "Passwords do not match.");
    valid = false;
  }

  return valid;
}

function togglePasswordVisibility(button) {
  const targetId = button.dataset.target;
  const input = document.getElementById(targetId);
  if (!input) {
    return;
  }

  const nextType = input.type === "password" ? "text" : "password";
  input.type = nextType;
  button.textContent = nextType === "password" ? "Show" : "Hide";
  button.setAttribute("aria-label", nextType === "password" ? "Show password" : "Hide password");
}

function showResetForm() {
  const loginPanel = document.getElementById("loginPanel");
  const resetPanel = document.getElementById("resetPanel");
  if (loginPanel && resetPanel) {
    loginPanel.classList.add("hidden");
    resetPanel.classList.remove("hidden");
  }
  setFormMessage("loginMessage", "");
  setFormMessage("resetMessage", "");
}

function showLoginForm() {
  const loginPanel = document.getElementById("loginPanel");
  const resetPanel = document.getElementById("resetPanel");
  if (loginPanel && resetPanel) {
    resetPanel.classList.add("hidden");
    loginPanel.classList.remove("hidden");
  }
  setFormMessage("resetMessage", "");
}

async function signup() {
  const username = getValue("username");
  const email = getValue("email");
  const password = getRawValue("password");

  if (!validateSignupForm()) {
    return;
  }

  setButtonState("signupButton", "Creating...", true);

  try {
    const response = await fetch(`${API}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password })
    });

    const data = await parseResponse(response);

    if (!response.ok) {
      setFormMessage("signupMessage", data.detail || "Signup failed.");
      return;
    }

    setFormMessage("signupMessage", "Account created successfully. Please log in.", "success");
    window.location.href = "login.html";
  } catch (error) {
    setFormMessage(
      "signupMessage",
      "Could not connect to the server. Please try again."
    );
  } finally {
    setButtonState("signupButton", "Creating...", false);
  }
}

async function login() {
  const identifier = getValue("identifier");
  const password = getRawValue("password");

  if (!validateLoginForm()) {
    return;
  }

  setButtonState("loginButton", "Logging in...", true);

  try {
    const response = await fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password })
    });

    const data = await parseResponse(response);

    if (!response.ok) {
      setFormMessage("loginMessage", data.detail || "Login failed.");
      return;
    }

    localStorage.setItem("token", data.access_token);
    localStorage.setItem("user", JSON.stringify(data.user));
    window.location.href = "index.html";
  } catch (error) {
    setFormMessage(
      "loginMessage",
      "Could not connect to the server. Please try again."
    );
  } finally {
    setButtonState("loginButton", "Logging in...", false);
  }
}

async function resetPassword() {
  const identifier = getValue("resetIdentifier");
  const new_password = getRawValue("resetPassword");

  if (!validateResetForm()) {
    return;
  }

  setButtonState("resetButton", "Resetting...", true);

  try {
    const response = await fetch(`${API}/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, new_password })
    });

    const data = await parseResponse(response);

    if (!response.ok) {
      setFormMessage("resetMessage", data.detail || "Password reset failed.");
      return;
    }

    setFormMessage("resetMessage", "Password reset successful. You can log in now.", "success");
    const resetForm = document.getElementById("resetPasswordForm");
    if (resetForm) {
      resetForm.reset();
    }
    setTimeout(showLoginForm, 800);
  } catch (error) {
    setFormMessage(
      "resetMessage",
      "Could not connect to the server. Please try again."
    );
  } finally {
    setButtonState("resetButton", "Resetting...", false);
  }
}

function handleAuthEnter(event, action) {
  if (event.key === "Enter") {
    action();
  }
}

function bindInlineValidation(fieldId, validator) {
  const field = document.getElementById(fieldId);
  if (!field) {
    return;
  }

  field.addEventListener("input", () => {
    clearFieldError(fieldId);
    if (typeof validator === "function") {
      validator();
    }
  });
}

function initializeAuthPage() {
  document.querySelectorAll(".password-toggle").forEach((button) => {
    button.addEventListener("click", () => togglePasswordVisibility(button));
  });

  bindInlineValidation("username");
  bindInlineValidation("email");
  bindInlineValidation("password");
  bindInlineValidation("identifier");
  bindInlineValidation("resetIdentifier");
  bindInlineValidation("resetPassword");
  bindInlineValidation("resetConfirmPassword");
}

document.addEventListener("DOMContentLoaded", initializeAuthPage);
