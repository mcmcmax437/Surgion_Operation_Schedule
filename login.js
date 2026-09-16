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
const googleQuickBtn = document.querySelector("#googleQuickBtn");
const googleOfficialBtn = document.querySelector("#googleOfficialBtn");
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
  if (label != null) button.textContent = label;
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
    : "Зареєструйтесь або увійдіть через Google.";
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
  if (googleQuickBtn) googleQuickBtn.disabled = true;
  try {
    const data = await api("/auth/google", {
      method: "POST",
      json: { credential: response.credential },
    });
    await completeLogin(data.token);
  } catch (err) {
    clearAuth();
    showError(mapAuthError(err, "Не вдалося увійти через Google."));
    if (googleQuickBtn) googleQuickBtn.disabled = false;
  }
}

async function resolveGoogleClientId() {
  // Prefer API config, then static auth.config.json (no .env needed).
  let clientId = String(authConfig.googleClientId || "").trim();
  if (clientId) return clientId;
  try {
    const response = await fetch("auth.config.json", { cache: "no-store" });
    if (response.ok) {
      const conf = await response.json();
      clientId = String(conf?.googleClientId || "").trim();
      if (clientId && !clientId.includes("YOUR_GOOGLE")) return clientId;
    }
  } catch {
    // optional
  }
  const fromApp = String(window.APP_CONFIG?.GOOGLE_CLIENT_ID || "").trim();
  return fromApp || "";
}

function initGoogleClient(clientId) {
  if (!clientId || !window.google?.accounts?.id) return false;
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleCredential,
    ux_mode: "popup",
    context: "signin",
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  googleReady = true;
  authConfig.googleClientId = clientId;
  authConfig.googleEnabled = true;
  return true;
}

function waitForGoogle(timeoutMs = 6000) {
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
    }, 80);
  });
}

async function prepareGoogle() {
  const clientId = await resolveGoogleClientId();
  if (!clientId) return false;
  const ready = await waitForGoogle();
  if (!ready) return false;
  return initGoogleClient(clientId);
}

async function startGoogleSignIn() {
  clearError();
  if (googleQuickBtn) googleQuickBtn.disabled = true;

  const ok = googleReady || await prepareGoogle();
  if (!ok || !authConfig.googleClientId) {
    if (googleQuickBtn) googleQuickBtn.disabled = false;
    showError("Google вхід ще не налаштовано: додайте googleClientId у файл auth.config.json і задеплойте.");
    return;
  }

  try {
    // Prefer One Tap / account chooser; also keep an official button as backup.
    window.google.accounts.id.prompt((notification) => {
      if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.()) {
        if (googleOfficialBtn) {
          googleOfficialBtn.hidden = false;
          googleOfficialBtn.innerHTML = "";
          window.google.accounts.id.renderButton(googleOfficialBtn, {
            theme: "outline",
            size: "large",
            shape: "rectangular",
            type: "icon",
            text: "signin_with",
            locale: "uk",
          });
        }
        if (googleQuickBtn) googleQuickBtn.disabled = false;
      }
    });
  } catch {
    if (googleOfficialBtn) {
      googleOfficialBtn.hidden = false;
      googleOfficialBtn.innerHTML = "";
      window.google.accounts.id.renderButton(googleOfficialBtn, {
        theme: "outline",
        size: "large",
        shape: "rectangular",
        type: "icon",
        text: "signin_with",
        locale: "uk",
      });
    }
    if (googleQuickBtn) googleQuickBtn.disabled = false;
  }
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

  // Also try static file so Google can work without API/env.
  if (!authConfig.googleClientId) {
    authConfig.googleClientId = await resolveGoogleClientId();
    authConfig.googleEnabled = Boolean(authConfig.googleClientId);
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

  // Warm up Google in the background so the G button responds faster.
  prepareGoogle().catch(() => {});
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

googleQuickBtn?.addEventListener("click", () => {
  startGoogleSignIn();
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
