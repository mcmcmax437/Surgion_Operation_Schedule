if (!window.SurgeryAPI) {
  alert("Не завантажено api.js. Оновіть сторінку (Ctrl+F5).");
  throw new Error("SurgeryAPI missing");
}
const { api, AUTH_KEY, TOKEN_KEY } = window.SurgeryAPI;

if (sessionStorage.getItem(AUTH_KEY) === "1" && sessionStorage.getItem(TOKEN_KEY)) {
  window.location.replace("index.html");
}

document.querySelector("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#accessPassword").value.trim();
  const error = document.querySelector("#loginError");
  error.hidden = true;

  try {
    const data = await api("/login", { method: "POST", json: { password } });
    sessionStorage.setItem(AUTH_KEY, "1");
    sessionStorage.setItem(TOKEN_KEY, data.token);
    window.location.replace("index.html");
  } catch (err) {
    const message = String(err.message || "");
    if (message.includes("API error 404") || message.includes("Немає зв")) {
      error.textContent = "API недоступне (404). Перевірте nginx /api/ і pm2.";
    } else if (message.includes("401") || message.toLowerCase().includes("invalid")) {
      error.textContent = "Неправильний пароль.";
    } else {
      error.textContent = message || "Помилка входу.";
    }
    error.hidden = false;
    document.querySelector("#accessPassword").select();
  }
});

document.querySelector("#showPassword").addEventListener("change", (event) => {
  document.querySelector("#accessPassword").type = event.target.checked ? "text" : "password";
});
