const AUTH_KEY = "surgery-authenticated";
const TOKEN_KEY = "surgery-token";

const API_BASE = window.APP_CONFIG?.API_BASE || "/api";

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.json) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.json ? JSON.stringify(options.json) : options.body,
  });

  if (response.status === 401 && !path.startsWith("/login")) {
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.replace("login.html");
    throw new Error("Unauthorized");
  }

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.blob();

  if (!response.ok) {
    const message = data?.error || "Request failed";
    throw new Error(message);
  }
  return data;
}

window.SurgeryAPI = { api, AUTH_KEY, TOKEN_KEY, API_BASE };
