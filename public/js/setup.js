// public/js/setup.js — First-run setup wizard logic (runs standalone on the
// setup server; no session, no api.js). Ported from polaris and adapted to
// Charon: the post-restart poll uses the current origin (so it works through a
// container port mapping) and verifies /health returns JSON status:"ok".

var currentStep = 1;
var connectionTested = false;
var sessionSecret = "";

// ─── Step navigation ──────────────────────────────────────────────

function goToStep(step) {
  currentStep = step;
  for (var i = 1; i <= 4; i++) {
    document.getElementById("step-" + i).classList.toggle("visible", i === step);
  }
  document.getElementById("step-progress").classList.remove("visible");
  updateStepper();
}

function updateStepper() {
  document.querySelectorAll(".stepper-step").forEach(function (el) {
    var s = parseInt(el.dataset.step, 10);
    el.classList.remove("active", "done");
    if (s === currentStep) el.classList.add("active");
    else if (s < currentStep) el.classList.add("done");
  });
  document.querySelectorAll(".stepper-line").forEach(function (el) {
    var l = parseInt(el.dataset.line, 10);
    el.classList.toggle("done", l < currentStep);
  });
}

// ─── Step 1: Database ─────────────────────────────────────────────

function getDbConfig() {
  var ssl = document.getElementById("db-ssl").checked;
  return {
    host: document.getElementById("db-host").value.trim(),
    port: parseInt(document.getElementById("db-port").value, 10) || 5432,
    username: document.getElementById("db-username").value.trim(),
    password: document.getElementById("db-password").value,
    database: document.getElementById("db-database").value.trim(),
    ssl: ssl,
    sslAllowSelfSigned: ssl && document.getElementById("db-ssl-allow-self-signed").checked,
  };
}

document.getElementById("db-ssl").addEventListener("change", function () {
  var row = document.getElementById("db-ssl-allow-self-signed-row");
  row.style.display = this.checked ? "flex" : "none";
  if (!this.checked) document.getElementById("db-ssl-allow-self-signed").checked = false;
});

document.getElementById("btn-test-conn").addEventListener("click", async function () {
  var btn = this;
  var resultEl = document.getElementById("test-result");
  btn.disabled = true;
  btn.textContent = "Testing...";
  resultEl.className = "test-result";
  resultEl.textContent = "";

  try {
    var db = getDbConfig();
    if (!db.host || !db.username || !db.database) {
      throw new Error("Host, username, and database name are required");
    }
    var res = await fetch("/api/setup/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(db),
    });
    var data = await res.json();
    if (data.ok) {
      resultEl.className = "test-result success";
      resultEl.textContent = data.message;
      connectionTested = true;
      document.getElementById("btn-next-1").disabled = false;
      // Fire-and-forget disk preflight — advisory only.
      runPreflight(db.host).catch(function () {});
    } else {
      resultEl.className = "test-result error";
      resultEl.textContent = data.message;
      connectionTested = false;
      document.getElementById("btn-next-1").disabled = true;
      hidePreflight();
    }
  } catch (err) {
    resultEl.className = "test-result error";
    resultEl.textContent = err.message || "Connection test failed";
    connectionTested = false;
    document.getElementById("btn-next-1").disabled = true;
    hidePreflight();
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
});

function hidePreflight() {
  var el = document.getElementById("preflight-result");
  if (el) el.style.display = "none";
}

async function runPreflight(dbHost) {
  var el = document.getElementById("preflight-result");
  if (!el) return;
  try {
    var res = await fetch("/api/setup/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dbHost: dbHost }),
    });
    var data = await res.json();
    if (!data || (Array.isArray(data.warnings) && data.warnings.length === 0)) {
      el.style.display = "none";
      return;
    }
    var warnings = (data.warnings || []).map(function (w) {
      return '<li style="margin-bottom:0.35rem">' + escapeHtml(w) + "</li>";
    }).join("");
    el.style.display = "block";
    el.style.background = "rgba(255, 167, 38, 0.10)";
    el.style.border = "1px solid rgba(255, 167, 38, 0.45)";
    el.style.color = "var(--color-text-primary)";
    el.innerHTML =
      "<strong>Disk preflight — review before proceeding</strong>" +
      '<ul style="margin:0.4rem 0 0;padding-left:1.1rem">' + warnings + "</ul>" +
      '<p class="hint" style="margin:0.5rem 0 0">These are advisories — you can still continue with setup.</p>';
  } catch (_err) {
    el.style.display = "none";
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Reset test when DB fields change
["db-host", "db-port", "db-username", "db-password", "db-database", "db-ssl", "db-ssl-allow-self-signed"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", function () {
    connectionTested = false;
    document.getElementById("btn-next-1").disabled = true;
    var r = document.getElementById("test-result");
    r.className = "test-result";
    r.textContent = "";
  });
});

document.getElementById("btn-next-1").addEventListener("click", function () {
  if (!connectionTested) return;
  goToStep(2);
});

// ─── Step 2: Admin ────────────────────────────────────────────────

var pwRules = {
  length: function (p) { return p.length >= 8; },
  lower: function (p) { return /[a-z]/.test(p); },
  upper: function (p) { return /[A-Z]/.test(p); },
  number: function (p) { return /[0-9]/.test(p); },
  special: function (p) { return /[^a-zA-Z0-9]/.test(p); },
};

function checkPasswordComplexity(pw) {
  var allPassed = true;
  Object.keys(pwRules).forEach(function (rule) {
    var passed = pwRules[rule](pw);
    if (!passed) allPassed = false;
    var el = document.querySelector('#pw-checks [data-rule="' + rule + '"]');
    if (el) {
      el.querySelector(".pw-icon").innerHTML = passed ? "&#10003;" : "&#9675;";
      el.style.color = passed ? "var(--color-success, #4caf50)" : "var(--color-text-tertiary)";
    }
  });
  return allPassed;
}

document.getElementById("admin-password").addEventListener("input", function () {
  checkPasswordComplexity(this.value);
});

document.getElementById("btn-back-2").addEventListener("click", function () { goToStep(1); });
document.getElementById("btn-next-2").addEventListener("click", function () {
  var username = document.getElementById("admin-username").value.trim();
  var password = document.getElementById("admin-password").value;
  var confirm = document.getElementById("admin-password-confirm").value;

  if (!username) { alert("Username is required"); return; }
  if (!checkPasswordComplexity(password)) { alert("Password does not meet complexity requirements"); return; }
  if (password !== confirm) { alert("Passwords do not match"); return; }
  goToStep(3);
});

// ─── Step 3: Settings ─────────────────────────────────────────────

async function generateSecret() {
  try {
    var res = await fetch("/api/setup/generate-secret", { method: "POST" });
    var data = await res.json();
    sessionSecret = data.secret;
    document.getElementById("app-secret").value = sessionSecret;
  } catch (_) {
    // Fallback: generate client-side
    var arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    sessionSecret = Array.from(arr).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    document.getElementById("app-secret").value = sessionSecret;
  }
}

generateSecret();

document.getElementById("btn-regen-secret").addEventListener("click", generateSecret);
document.getElementById("btn-back-3").addEventListener("click", function () { goToStep(2); });
document.getElementById("btn-next-3").addEventListener("click", function () {
  var port = parseInt(document.getElementById("app-port").value, 10);
  if (!port || port < 1 || port > 65535) { alert("Port must be between 1 and 65535"); return; }
  if (!sessionSecret) { alert("Session secret is required"); return; }

  // Populate review
  var db = getDbConfig();
  document.getElementById("review-db").innerHTML =
    rv("Host", db.host + ":" + db.port) +
    rv("Username", db.username) +
    rv("Database", db.database) +
    rv("SSL", db.ssl ? (db.sslAllowSelfSigned ? "Enabled (allow self-signed)" : "Enabled") : "Disabled");

  document.getElementById("review-admin").innerHTML =
    rv("Username", document.getElementById("admin-username").value.trim()) +
    rv("Password", "••••••••");

  document.getElementById("review-app").innerHTML =
    rv("HTTP Port", port) +
    rv("Session Secret", sessionSecret.substring(0, 12) + "…");

  goToStep(4);
});

function rv(label, value) {
  return "<dt>" + escapeHtml(label) + "</dt><dd>" + escapeHtml(value) + "</dd>";
}

// ─── Step 4: Finalize ─────────────────────────────────────────────

document.getElementById("btn-back-4").addEventListener("click", function () { goToStep(3); });
document.getElementById("btn-finalize").addEventListener("click", async function () {
  var btn = this;
  btn.disabled = true;

  for (var i = 1; i <= 4; i++) document.getElementById("step-" + i).classList.remove("visible");
  var progress = document.getElementById("step-progress");
  progress.classList.add("visible");
  var msgEl = document.getElementById("progress-msg");
  msgEl.textContent = "Writing configuration...";

  try {
    var payload = {
      db: getDbConfig(),
      admin: {
        username: document.getElementById("admin-username").value.trim(),
        password: document.getElementById("admin-password").value,
      },
      app: {
        port: parseInt(document.getElementById("app-port").value, 10) || 3000,
        sessionSecret: sessionSecret,
      },
    };

    msgEl.textContent = "Creating database and running migrations...";
    var res = await fetch("/api/setup/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    var data = await res.json();

    if (!data.ok) {
      progress.querySelector(".spinner").style.display = "none";
      msgEl.textContent = "Setup failed: " + (data.message || "Unknown error");
      btn.disabled = false;
      goToStep(4);
      alert("Setup failed: " + (data.message || "Unknown error"));
      return;
    }

    // Success — the server is restarting into the full app. Poll /health on the
    // SAME origin (works through a container port mapping) and verify it returns
    // JSON status:"ok" — the setup server serves setup.html for /health, so a
    // bare 200 isn't enough to know the real app is up.
    msgEl.textContent = "Setup complete! The application is restarting...";
    var healthHeaders = data.healthToken ? { Authorization: "Bearer " + data.healthToken } : {};
    var attempts = 0;
    var maxAttempts = 40;
    var poll = setInterval(async function () {
      attempts++;
      try {
        var hr = await fetch("/health", { headers: healthHeaders, cache: "no-store", signal: AbortSignal.timeout(2000) });
        var ct = hr.headers.get("content-type") || "";
        if (hr.ok && ct.indexOf("application/json") !== -1) {
          var hd = await hr.json();
          if (hd && hd.status === "ok") {
            clearInterval(poll);
            msgEl.textContent = "Application is ready! Redirecting...";
            setTimeout(function () { window.location.href = "/login.html"; }, 1000);
            return;
          }
        }
      } catch (_) {
        // Not ready yet (connection refused during restart, or still the wizard).
      }
      if (attempts >= maxAttempts) {
        clearInterval(poll);
        progress.querySelector(".spinner").style.display = "none";
        msgEl.innerHTML =
          "The application did not come back automatically.<br><br>" +
          "Once it has restarted, visit " +
          '<a href="/login.html" style="color:var(--color-primary,#4a9eff)">the login page</a>.';
      }
    }, 2000);
  } catch (err) {
    progress.querySelector(".spinner").style.display = "none";
    msgEl.textContent = "Setup failed: " + (err.message || "Network error");
  }
});
