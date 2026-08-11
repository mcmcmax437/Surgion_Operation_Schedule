const AUTH_KEY = "surgery-authenticated";
const ACCESS_PASSWORD = window.APP_CONFIG?.ACCESS_PASSWORD || "";

if (sessionStorage.getItem(AUTH_KEY) === "1") {
  window.location.replace("index.html");
}

document.querySelector("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const password = document.querySelector("#accessPassword").value.trim();
  const error = document.querySelector("#loginError");

  if (ACCESS_PASSWORD && password === ACCESS_PASSWORD) {
    sessionStorage.setItem(AUTH_KEY, "1");
    window.location.replace("index.html");
    return;
  }

  error.hidden = false;
  document.querySelector("#accessPassword").select();
});

document.querySelector("#showPassword").addEventListener("change", (event) => {
  document.querySelector("#accessPassword").type = event.target.checked ? "text" : "password";
});
