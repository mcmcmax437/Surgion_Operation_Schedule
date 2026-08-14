if (!window.SurgeryAPI) {
  alert("Не завантажено api.js. Оновіть сторінку (Ctrl+F5).");
  throw new Error("SurgeryAPI missing");
}
const { api, getToken, setAuth, clearAuth } = window.SurgeryAPI;

const form = document.querySelector("#loginForm");
const button = form.querySelector("button[type='submit']");
const error = document.querySelector("#loginError");
const passwordInput = document.querySelector("#accessPassword");

function showError(message) {
  error.textContent = message;
  error.hidden = false;
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

enterIfSessionValid();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const password = passwordInput.value.trim();
  if (!password) return;

  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = "Вхід…";

  try {
    const data = await api("/login", { method: "POST", json: { password } });
    setAuth(data.token);
    await api("/session");
    window.location.replace("index.html");
  } catch (err) {
    clearAuth();
    const message = String(err.message || "");
    if (message.includes("API error 404") || message.includes("Немає зв")) {
      showError("API недоступне (404). Перевірте nginx /api/ і pm2.");
    } else if (message.includes("401") || message.toLowerCase().includes("invalid") || message === "Unauthorized") {
      showError("Неправильний пароль.");
    } else {
      showError(message || "Помилка входу.");
    }
    passwordInput.select();
    button.disabled = false;
    button.textContent = previousLabel;
  }
});

document.querySelector("#showPassword").addEventListener("change", (event) => {
  passwordInput.type = event.target.checked ? "text" : "password";
});
