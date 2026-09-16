if (!window.SurgeryAPI) {
  alert("Не завантажено api.js. Оновіть сторінку (Ctrl+F5).");
  throw new Error("SurgeryAPI missing");
}
const { api, getToken, setAuth, clearAuth } = window.SurgeryAPI;

const error = document.querySelector("#loginError");
const loginPanel = document.querySelector("#loginPanel");
const registerPanel = document.querySelector("#registerPanel");
const recoverPanel = document.querySelector("#recoverPanel");
const sharedPanel = document.querySelector("#sharedPanel");
const sharedToggle = document.querySelector("#sharedToggle");
const googleOfficialBtn = document.querySelector("#googleOfficialBtn");
const googleQuickBtns = [...document.querySelectorAll(".google-quick-btn")];
const authTitle = document.querySelector("#authTitle");
const authLead = document.querySelector("#authLead");
const authSwitchWrap = document.querySelector("#authSwitchWrap");
const authSwitchHint = document.querySelector("#authSwitchHint");
const authSwitchBtn = document.querySelector("#authSwitchBtn");
const forgotPasswordBtn = document.querySelector("#forgotPasswordBtn");
const recoverBackBtn = document.querySelector("#recoverBackBtn");

let authConfig = {
  registrationEnabled: true,
  googleEnabled: false,
  googleClientId: null,
  sharedPasswordEnabled: false,
};
let googleReady = false;
let currentPanel = "login";

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

function setGoogleBusy(busy) {
  googleQuickBtns.forEach((btn) => {
    btn.disabled = busy;
  });
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
  currentPanel = panelId;
  const isLogin = panelId === "login";
  const isRegister = panelId === "register";
  const isRecover = panelId === "recover";

  if (loginPanel) loginPanel.hidden = !isLogin;
  if (registerPanel) registerPanel.hidden = !isRegister;
  if (recoverPanel) recoverPanel.hidden = !isRecover;
  if (sharedPanel && !isLogin) sharedPanel.hidden = true;

  if (authTitle) {
    authTitle.textContent = isRegister ? "Реєстрація" : isRecover ? "Пароль" : "Вхід";
  }
  if (authLead) {
    authLead.textContent = isRegister
      ? "Створіть акаунт або увійдіть через Google."
      : isRecover
        ? "Як відновити доступ до акаунту."
        : "Увійдіть через email і пароль або Google.";
  }

  if (authSwitchWrap) {
    authSwitchWrap.hidden = isRecover || (!authConfig.registrationEnabled && isLogin);
  }
  if (isLogin) {
    if (authSwitchHint) authSwitchHint.textContent = "Немає акаунту?";
    if (authSwitchBtn) authSwitchBtn.textContent = "Реєстрація";
  } else if (isRegister) {
    if (authSwitchHint) authSwitchHint.textContent = "Вже є акаунт?";
    if (authSwitchBtn) authSwitchBtn.textContent = "Увійти";
  }
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
  setGoogleBusy(true);
  try {
    const data = await api("/auth/google", {
      method: "POST",
      json: { credential: response.credential },
    });
    await completeLogin(data.token);
  } catch (err) {
    clearAuth();
    showError(mapAuthError(err, "Не вдалося увійти через Google."));
    setGoogleBusy(false);
  }
}

async function resolveGoogleClientId() {
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
  setGoogleBusy(true);

  const ok = googleReady || await prepareGoogle();
  if (!ok || !authConfig.googleClientId) {
    setGoogleBusy(false);
    showError("Google вхід ще не налаштовано: додайте googleClientId у файл auth.config.json і задеплойте.");
    return;
  }

  try {
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
        setGoogleBusy(false);
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
    setGoogleBusy(false);
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

  if (!authConfig.googleClientId) {
    authConfig.googleClientId = await resolveGoogleClientId();
    authConfig.googleEnabled = Boolean(authConfig.googleClientId);
  }

  showPanel("login");
  if (authConfig.sharedPasswordEnabled && sharedToggle) {
    sharedToggle.hidden = false;
  }

  prepareGoogle().catch(() => {});
}

authSwitchBtn?.addEventListener("click", () => {
  if (currentPanel === "login") {
    if (!authConfig.registrationEnabled) {
      showError("Реєстрація вимкнена адміністратором.");
      return;
    }
    showPanel("register");
    return;
  }
  showPanel("login");
});

forgotPasswordBtn?.addEventListener("click", () => {
  showPanel("recover");
});

recoverBackBtn?.addEventListener("click", () => {
  showPanel("login");
});

sharedToggle?.addEventListener("click", () => {
  if (!sharedPanel) return;
  sharedPanel.hidden = !sharedPanel.hidden;
  sharedToggle.textContent = sharedPanel.hidden
    ? "Пароль відділення"
    : "Сховати пароль відділення";
});

googleQuickBtns.forEach((btn) => {
  btn.addEventListener("click", () => startGoogleSignIn());
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
