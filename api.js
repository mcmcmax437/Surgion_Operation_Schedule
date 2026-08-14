(() => {
  const AUTH_KEY = "surgery-authenticated";
  const TOKEN_KEY = "surgery-token";
  const API_BASE = (window.APP_CONFIG && window.APP_CONFIG.API_BASE) || "/api";

  function readStore(key) {
    return localStorage.getItem(key) || sessionStorage.getItem(key);
  }

  function migrateSessionToLocal() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const authed = sessionStorage.getItem(AUTH_KEY);
    if (token && !localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(AUTH_KEY, authed || "1");
    }
    if (localStorage.getItem(TOKEN_KEY)) {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(AUTH_KEY);
    }
  }

  migrateSessionToLocal();

  function getToken() {
    return readStore(TOKEN_KEY);
  }

  function isAuthenticated() {
    return readStore(AUTH_KEY) === "1" && Boolean(getToken());
  }

  function setAuth(token) {
    localStorage.setItem(AUTH_KEY, "1");
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  }

  function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.json) {
      headers["Content-Type"] = "application/json";
    }

    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
        body: options.json ? JSON.stringify(options.json) : options.body,
      });
    } catch {
      throw new Error("Немає зв’язку з API. Перевірте nginx /api/ і що Node запущений (pm2).");
    }

    if (response.status === 401 && path.indexOf("/login") !== 0) {
      clearAuth();
      window.location.replace("login.html");
      throw new Error("Unauthorized");
    }

    const contentType = response.headers.get("content-type") || "";
    let data = null;
    if (contentType.indexOf("application/json") !== -1) {
      data = await response.json();
    } else if (contentType.indexOf("text/") !== -1) {
      data = { error: await response.text() };
    } else {
      data = await response.blob();
    }

    if (!response.ok) {
      const message = (data && data.error) || ("API error " + response.status);
      throw new Error(typeof message === "string" ? message.slice(0, 200) : "Request failed");
    }
    return data;
  }

  window.SurgeryAPI = {
    api,
    AUTH_KEY,
    TOKEN_KEY,
    API_BASE,
    getToken,
    isAuthenticated,
    setAuth,
    clearAuth,
  };
})();
