if (!window.SurgeryAPI) {
  alert("Не завантажено api.js. Оновіть сторінку (Ctrl+F5).");
  throw new Error("SurgeryAPI missing");
}
const { api, getToken, setAuth, clearAuth } = window.SurgeryAPI;

const error = document.querySelector("#loginError");
const loginPanel = document.querySelector("#loginPanel");
const registerPanel = document.querySelector("#registerPanel");
const sharedPanel = document.querySelector("#sharedPanel");
const sharedToggle = document.querySelector("#sharedToggle");
const googleWrap = document.querySelector("#googleSignInWrap");
const googleBox = document.querySelector("#googleSignIn");
const googleFallbackBtn = document.querySelector("#googleFallbackBtn");
const googleDivider = document.querySelector("#googleDivider");
const tabLogin = document.querySelector("#tabLogin");
const tabRegister = document.querySelector("#tabRegister");
const authLead = document.querySelector("#authLead");

let authConfig = {
  registrationEnabled: true,
  googleEnabled: false,
  googleClientId: null,
  sharedPasswordEnabled: false,
};
let googleReady = false;

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

function clearError() {
  error.hidden = true;
  error.textContent = "";
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (label) button.textContent = label;
}

async function enterIfSessionValid() {
  if (!getToken()) return;
  try {
    await api("/session");
    window.location.replace("index.html");
  } catch {
    clearAuth();
  }
}

function showPanel(panelId) {
  clearError();
  const isLogin = panelId === "loginPanel";
  loginPanel.hidden = !isLogin;
  registerPanel.hidden = isLogin;
  tabLogin.classList.toggle("is-active", isLogin);
  tabRegister.classList.toggle("is-active", !isLogin);
  authLead.textContent = isLogin
    ? "Увійдіть через Google або email і пароль."
    : "Створіть акаунт лікаря для доступу до розкладу.";
}

function mapAuthError(err, fallback) {
  const message = String(err?.message || "");
  if (
    message.includes("API error 404")
    || message.includes("Немає зв")
    || message.includes("шлюз")
    || message.includes("502")
    || message.includes("503")
  ) {
    return "API недоступне. Перевірте nginx /api/ і pm2 (surgion-schedule-api).";
  }
  if (message.includes("тимчасово недоступний")) return message;
  if (message && !message.startsWith("API error")) return message;
  return fallback;
}

async function completeLogin(token) {
  setAuth(token);
  await api("/session");
  window.location.replace("index.html");
}

async function handleGoogleCredential(response) {
  clearError();
  if (!response?.credential) {
    showError("Google не повернув дані для входу.");
    return;
  }
  try {
    const data = await api("/auth/google", {
      method: "POST",
      json: { credential: response.credential },
    });
    await completeLogin(data.token);
  } catch (err) {
    clearAuth();
    showError(mapAuthError(err, "Не вдалося увійти через Google."));
  }
}

function initGoogleClient() {
  if (!authConfig.googleEnabled || !authConfig.googleClientId || !window.google?.accounts?.id) {
    return false;
  }
  window.google.accounts.id.initialize({
    client_id: authConfig.googleClientId,
    callback: handleGoogleCredential,
    ux_mode: "popup",
    context: "signin",
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  googleReady = true;
  return true;
}

function renderGoogleButton() {
  if (!authConfig.googleEnabled || !authConfig.googleClientId) {
    if (googleWrap) googleWrap.hidden = true;
    if (googleDivider) googleDivider.hidden = true;
    return false;
  }
  if (googleWrap) googleWrap.hidden = false;
  if (googleDivider) googleDivider.hidden = false;

  if (!initGoogleClient()) {
    if (googleFallbackBtn) googleFallbackBtn.hidden = false;
    return false;
  }

  if (googleBox) {
    googleBox.innerHTML = "";
    googleBox.hidden = false;
    try {
      window.google.accounts.id.renderButton(googleBox, {
        theme: "outline",
        size: "large",
        shape: "rectangular",
        text: "continue_with",
        width: Math.min(360, Math.floor((googleWrap?.clientWidth || 320))),
        locale: "uk",
      });
      if (googleFallbackBtn) googleFallbackBtn.hidden = true;
    } catch {
      if (googleFallbackBtn) googleFallbackBtn.hidden = false;
    }
  } else if (googleFallbackBtn) {
    googleFallbackBtn.hidden = false;
  }
  return true;
}

function waitForGoogle(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (window.google?.accounts?.id) {
      resolve(true);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.google?.accounts?.id) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

async function loadAuthConfig() {
  try {
    authConfig = await api("/auth/config");
  } catch {
    authConfig = {
      registrationEnabled: true,
      googleEnabled: false,
      googleClientId: null,
      sharedPasswordEnabled: true,
    };
  }

  if (!authConfig.registrationEnabled) {
    tabRegister.hidden = true;
    showPanel("loginPanel");
  } else {
    showPanel("registerPanel");
  }
  if (authConfig.sharedPasswordEnabled) {
    sharedToggle.hidden = false;
  }
  if (authConfig.googleEnabled && authConfig.googleClientId) {
    const ready = await waitForGoogle();
    if (ready) renderGoogleButton();
    else {
      if (googleWrap) googleWrap.hidden = false;
      if (googleDivider) googleDivider.hidden = false;
      if (googleFallbackBtn) googleFallbackBtn.hidden = false;
    }
  } else {
    if (googleWrap) googleWrap.hidden = true;
    if (googleDivider) googleDivider.hidden = true;
  }
}

tabLogin?.addEventListener("click", () => showPanel("loginPanel"));
tabRegister?.addEventListener("click", () => {
  if (!authConfig.registrationEnabled) {
    showError("Реєстрація вимкнена адміністратором.");
    return;
  }
  showPanel("registerPanel");
});

sharedToggle?.addEventListener("click", () => {
  sharedPanel.hidden = !sharedPanel.hidden;
  sharedToggle.textContent = sharedPanel.hidden
    ? "Вхід за паролем відділення"
    : "Сховати пароль відділення";
});

googleFallbackBtn?.addEventListener("click", () => {
  clearError();
  if (!authConfig.googleClientId) {
    showError("Google вхід ще не налаштовано (немає Client ID).");
    return;
  }
  if (!window.google?.accounts?.id) {
    showError("Не завантажено Google Sign-In. Перевірте мережу і оновіть сторінку.");
    return;
  }
  if (!googleReady) initGoogleClient();
  try {
    window.google.accounts.id.prompt((notification) => {
      if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.()) {
        // Fallback: open the button flow by re-rendering official button.
        renderGoogleButton();
        showError("Натисніть кнопку Google ще раз для входу.");
      }
    });
  } catch {
    renderGoogleButton();
  }
});

document.querySelector("#showLoginPassword")?.addEventListener("change", (event) => {
  document.querySelector("#loginPassword").type = event.target.checked ? "text" : "password";
});
document.querySelector("#showRegisterPassword")?.addEventListener("change", (event) => {
  const type = event.target.checked ? "text" : "password";
  document.querySelector("#registerPassword").type = type;
  document.querySelector("#registerPassword2").type = type;
});
document.querySelector("#showSharedPassword")?.addEventListener("change", (event) => {
  document.querySelector("#accessPassword").type = event.target.checked ? "text" : "password";
});

loginPanel?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const button = document.querySelector("#loginSubmit");
  const email = document.querySelector("#loginEmail").value.trim();
  const password = document.querySelector("#loginPassword").value;
  setBusy(button, true, "Вхід…");
  try {
    const data = await api("/login", { method: "POST", json: { email, password } });
    await completeLogin(data.token);
  } catch (err) {
    clearAuth();
    showError(mapAuthError(err, "Невірний email або пароль."));
    setBusy(button, false, "Увійти");
  }
});

registerPanel?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const button = document.querySelector("#registerSubmit");
  const name = document.querySelector("#registerName").value.trim();
  const email = document.querySelector("#registerEmail").value.trim();
  const password = document.querySelector("#registerPassword").value;
  const password2 = document.querySelector("#registerPassword2").value;
  if (password !== password2) {
    showError("Паролі не збігаються.");
    return;
  }
  if (password.length < 8) {
    showError("Пароль має містити щонайменше 8 символів.");
    return;
  }
  setBusy(button, true, "Створення…");
  try {
    const data = await api("/register", { method: "POST", json: { name, email, password } });
    await completeLogin(data.token);
  } catch (err) {
    clearAuth();
    showError(mapAuthError(err, "Не вдалося зареєструватися."));
    setBusy(button, false, "Створити акаунт");
  }
});

sharedPanel?.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();
  const button = document.querySelector("#sharedSubmit");
  const password = document.querySelector("#accessPassword").value.trim();
  if (!password) {
    showError("Введіть пароль відділення.");
    return;
  }
  setBusy(button, true, "Вхід…");
  try {
    const data = await api("/login", { method: "POST", json: { password } });
    await completeLogin(data.token);
  } catch (err) {
    clearAuth();
    showError(mapAuthError(err, "Неправильний пароль відділення."));
    setBusy(button, false, "Увійти паролем відділення");
  }
});

enterIfSessionValid();
loadAuthConfig();
