import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import querystring from "node:querystring";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);
const ASSET_VERSION = "20260525-5";
const SESSION_COOKIE = "pp_session";
const CSRF_COOKIE = "csrf_token";
const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;
const IS_PROD = process.env.NODE_ENV === "production";

let bcrypt = null;
try {
  const bcryptModule = await import("bcryptjs");
  bcrypt = bcryptModule.default ?? bcryptModule;
} catch {
  bcrypt = null;
}

const ENUMS = {
  hadap: ["Utara", "Selatan", "Timur", "Barat"],
  tipe: ["Ruko", "Villa"],
  status: ["in_stock", "sold_out"],
  siap: ["siap_huni", "siap_kosong", "siap_huni_renovasi"],
  kawasan: [
    "Krakatau",
    "Pancing",
    "Tembung",
    "Helvetia",
    "Cemara Asri/Kuala",
    "Setia Budi",
    "Sunggal",
    "Marelan",
    "Johor",
    "Amplas"
  ]
};

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const rateBuckets = new Map();

await ensureData();

const server = http.createServer(async (req, res) => {
  try {
    if (!consumeRateLimit(req, res, "global", 100, 60 * 1000)) return;

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, standardHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && (await serveStatic(url, res))) return;

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method === "GET") {
      await handlePage(req, res, url);
      return;
    }

    sendText(res, 405, "Method Not Allowed");
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Terjadi kesalahan server." });
  }
});

server.listen(PORT, () => {
  console.log(`Prime Property berjalan di http://localhost:${PORT}`);
  console.log(`Login superadmin: superadmin@primeproperty.local / PrimeSuper123!`);
  console.log(`Login admin: admin@primeproperty.local / PrimeAdmin123!`);
});

async function handlePage(req, res, url) {
  const csrf = ensureCsrf(req, res);

  if (url.pathname === "/") {
    const store = await readJson("properties.json", { properties: [] });
    const featured = store.properties
      .filter((item) => !item.deleted_at && item.status === "in_stock")
      .slice(0, 6);

    sendHtml(
      res,
      renderPublicPage({
        title: "Prime Property",
        active: "home",
        csrf,
        body: renderLanding(featured)
      })
    );
    return;
  }

  if (url.pathname === "/about") {
    sendHtml(
      res,
      renderPublicPage({
        title: "Tentang Kami | Prime Property",
        active: "about",
        csrf,
        body: renderAbout()
      })
    );
    return;
  }

  if (url.pathname === "/contact") {
    sendHtml(
      res,
      renderPublicPage({
        title: "Kontak | Prime Property",
        active: "contact",
        csrf,
        body: renderContact()
      })
    );
    return;
  }

  if (url.pathname === "/agent/login") {
    const session = await getSession(req);
    if (session) {
      redirect(res, "/agent");
      return;
    }

    sendHtml(res, renderLoginPage(csrf));
    return;
  }

  if (url.pathname === "/agent" || url.pathname.startsWith("/agent/")) {
    const session = await getSession(req);
    if (!session) {
      redirect(res, "/agent/login");
      return;
    }

    sendHtml(res, renderDashboardPage(csrf));
    return;
  }

  sendHtml(
    res,
    renderPublicPage({
      title: "Halaman Tidak Ditemukan | Prime Property",
      active: "",
      csrf,
      body: `<section class="not-found"><h1>404</h1><p>Halaman yang dicari tidak tersedia.</p><a class="btn primary" href="/">Kembali ke Beranda</a></section>`
    }),
    404
  );
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/csrf" && req.method === "GET") {
    sendJson(res, 200, { csrfToken: ensureCsrf(req, res) });
    return;
  }

  if (url.pathname === "/api/contact" && req.method === "POST") {
    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;
    if (!consumeRateLimit(req, res, "contact", 3, 60 * 60 * 1000)) return;

    const errors = validateContact(body);
    if (Object.keys(errors).length) {
      sendJson(res, 422, { errors });
      return;
    }

    const messages = await readJson("contact_messages.json", { messages: [] });
    const outbox = await readJson("contact_outbox.json", { notifications: [] });
    const message = {
      id: crypto.randomUUID(),
      name: cleanText(body.name, 100),
      email: cleanText(body.email, 160).toLowerCase(),
      phone: cleanText(body.phone, 32),
      message: cleanText(body.message, 1500),
      ip: getIp(req),
      created_at: new Date().toISOString()
    };

    messages.messages.unshift(message);
    outbox.notifications.unshift({
      id: crypto.randomUUID(),
      to: process.env.ADMIN_EMAIL || "admin@primeproperty.local",
      subject: `Pesan baru dari ${message.name}`,
      body: `Nama: ${message.name}\nEmail: ${message.email}\nNomor HP: ${message.phone}\n\n${message.message}`,
      status: "queued",
      created_at: message.created_at
    });

    await writeJson("contact_messages.json", messages);
    await writeJson("contact_outbox.json", outbox);
    sendJson(res, 200, { ok: true, message: "Pesan terkirim, tim kami akan menghubungi Anda." });
    return;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    if (!consumeRateLimit(req, res, "auth", 10, 60 * 1000)) return;
    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;

    const email = cleanText(body.email, 160).toLowerCase();
    const password = String(body.password || "");
    const usersStore = await readJson("users.json", { users: [] });
    const user = usersStore.users.find((item) => item.email.toLowerCase() === email);

    if (!user || !user.enabled) {
      sendJson(res, 401, { error: "Email atau password tidak valid." });
      return;
    }

    if (user.lockout_until && Date.parse(user.lockout_until) > Date.now()) {
      sendJson(res, 423, { error: "Akun terkunci sementara. Coba lagi setelah 15 menit." });
      return;
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      const attempts = (user.failed_logins || []).filter((value) => Date.parse(value) > cutoff);
      attempts.push(new Date().toISOString());
      user.failed_logins = attempts;
      if (attempts.length >= 5) {
        user.lockout_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      await writeJson("users.json", usersStore);
      sendJson(res, 401, { error: "Email atau password tidak valid." });
      return;
    }

    user.failed_logins = [];
    user.lockout_until = null;
    user.last_login_at = new Date().toISOString();
    await writeJson("users.json", usersStore);

    const sessionsStore = await readJson("sessions.json", { sessions: [] });
    const session = {
      id: crypto.randomUUID(),
      user_id: user.id,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + THIRTY_DAYS).toISOString()
    };
    sessionsStore.sessions = sessionsStore.sessions
      .filter((item) => Date.parse(item.expires_at) > Date.now())
      .concat(session);
    await writeJson("sessions.json", sessionsStore);

    setCookie(res, SESSION_COOKIE, session.id, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: Math.floor(THIRTY_DAYS / 1000),
      secure: IS_PROD,
      path: "/"
    });
    sendJson(res, 200, { ok: true, redirect: "/agent" });
    return;
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;
    const cookies = parseCookies(req);
    const sessionsStore = await readJson("sessions.json", { sessions: [] });
    sessionsStore.sessions = sessionsStore.sessions.filter((item) => item.id !== cookies[SESSION_COOKIE]);
    await writeJson("sessions.json", sessionsStore);
    clearCookie(res, SESSION_COOKIE);
    sendJson(res, 200, { ok: true, redirect: "/agent/login" });
    return;
  }

  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Sesi tidak valid. Silakan login kembali." });
    return;
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    sendJson(res, 200, { user: publicUser(session.user) });
    return;
  }

  if (url.pathname === "/api/properties" && req.method === "GET") {
    const store = await readJson("properties.json", { properties: [] });
    const includeDeleted = url.searchParams.get("includeDeleted") === "true" && session.user.role === "superadmin";
    const properties = store.properties.filter((item) => includeDeleted || !item.deleted_at);
    sendJson(res, 200, { properties });
    return;
  }

  if (url.pathname === "/api/properties" && req.method === "POST") {
    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;
    if (!requireSuperadmin(res, session.user)) return;

    const { value, errors } = validateProperty(body);
    if (Object.keys(errors).length) {
      sendJson(res, 422, { errors });
      return;
    }

    const store = await readJson("properties.json", { properties: [] });
    const now = new Date().toISOString();
    const property = {
      id: crypto.randomUUID(),
      ...value,
      created_at: now,
      updated_at: now,
      created_by: session.user.id,
      deleted_at: null
    };
    store.properties.unshift(property);
    await writeJson("properties.json", store);
    await addAudit(session.user, "create_property", property.id, { after: property });
    sendJson(res, 201, { property });
    return;
  }

  const propertyMatch = url.pathname.match(/^\/api\/properties\/([^/]+)$/);
  if (propertyMatch) {
    const propertyId = decodeURIComponent(propertyMatch[1]);
    const store = await readJson("properties.json", { properties: [] });
    const property = store.properties.find((item) => item.id === propertyId);

    if (!property || property.deleted_at) {
      sendJson(res, 404, { error: "Properti tidak ditemukan." });
      return;
    }

    if (req.method === "GET") {
      sendJson(res, 200, { property });
      return;
    }

    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;
    if (!requireSuperadmin(res, session.user)) return;

    if (req.method === "PUT" || req.method === "PATCH") {
      const { value, errors } = validateProperty(body);
      if (Object.keys(errors).length) {
        sendJson(res, 422, { errors });
        return;
      }

      const before = structuredClone(property);
      Object.assign(property, value, { updated_at: new Date().toISOString() });
      await writeJson("properties.json", store);
      await addAudit(session.user, "update_property", property.id, diffProperty(before, property));
      sendJson(res, 200, { property });
      return;
    }

    if (req.method === "DELETE") {
      const before = structuredClone(property);
      property.deleted_at = new Date().toISOString();
      property.updated_at = property.deleted_at;
      await writeJson("properties.json", store);
      await addAudit(session.user, "delete_property", property.id, {
        before,
        after: { id: property.id, deleted_at: property.deleted_at }
      });
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (url.pathname === "/api/users" && req.method === "GET") {
    if (!requireSuperadmin(res, session.user)) return;
    const usersStore = await readJson("users.json", { users: [] });
    sendJson(res, 200, { users: usersStore.users.map(publicUser) });
    return;
  }

  if (url.pathname === "/api/users" && req.method === "POST") {
    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;
    if (!requireSuperadmin(res, session.user)) return;

    const errors = {};
    const email = cleanText(body.email, 160).toLowerCase();
    const name = cleanText(body.name, 100);
    const password = String(body.password || "");
    if (name.length < 3) errors.name = "Nama minimal 3 karakter.";
    if (!isValidEmail(email)) errors.email = "Email tidak valid.";
    if (password.length < 10) errors.password = "Password minimal 10 karakter.";

    const usersStore = await readJson("users.json", { users: [] });
    if (usersStore.users.some((item) => item.email.toLowerCase() === email)) {
      errors.email = "Email sudah digunakan.";
    }

    if (Object.keys(errors).length) {
      sendJson(res, 422, { errors });
      return;
    }

    const user = {
      id: crypto.randomUUID(),
      name,
      email,
      role: "admin",
      enabled: true,
      password_hash: await hashPassword(password),
      failed_logins: [],
      lockout_until: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    usersStore.users.push(user);
    await writeJson("users.json", usersStore);
    await addAudit(session.user, "create_admin", user.id, { after: publicUser(user) });
    sendJson(res, 201, { user: publicUser(user) });
    return;
  }

  const userToggleMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userToggleMatch && req.method === "PATCH") {
    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;
    if (!requireSuperadmin(res, session.user)) return;

    const userId = decodeURIComponent(userToggleMatch[1]);
    const usersStore = await readJson("users.json", { users: [] });
    const target = usersStore.users.find((item) => item.id === userId);
    if (!target) {
      sendJson(res, 404, { error: "User tidak ditemukan." });
      return;
    }
    if (target.id === session.user.id && body.enabled === false) {
      sendJson(res, 422, { error: "Superadmin tidak dapat menonaktifkan akun sendiri." });
      return;
    }

    const before = publicUser(target);
    target.enabled = Boolean(body.enabled);
    target.updated_at = new Date().toISOString();
    await writeJson("users.json", usersStore);
    await addAudit(session.user, target.enabled ? "enable_admin" : "disable_admin", target.id, {
      before,
      after: publicUser(target)
    });
    sendJson(res, 200, { user: publicUser(target) });
    return;
  }

  const resetMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/reset-password$/);
  if (resetMatch && req.method === "POST") {
    const body = await readBody(req);
    if (!requireCsrf(req, res, body)) return;
    if (!requireSuperadmin(res, session.user)) return;

    const userId = decodeURIComponent(resetMatch[1]);
    const usersStore = await readJson("users.json", { users: [] });
    const target = usersStore.users.find((item) => item.id === userId);
    if (!target) {
      sendJson(res, 404, { error: "User tidak ditemukan." });
      return;
    }

    const temporaryPassword = generateTemporaryPassword();
    target.password_hash = await hashPassword(temporaryPassword);
    target.failed_logins = [];
    target.lockout_until = null;
    target.updated_at = new Date().toISOString();
    await writeJson("users.json", usersStore);
    await addAudit(session.user, "reset_admin_password", target.id, { target: publicUser(target) });
    sendJson(res, 200, { user: publicUser(target), temporaryPassword });
    return;
  }

  if (url.pathname === "/api/audit-logs" && req.method === "GET") {
    if (!requireSuperadmin(res, session.user)) return;
    const logs = await readJson("audit_logs.json", { logs: [] });
    sendJson(res, 200, { logs: logs.logs.slice(0, 200) });
    return;
  }

  sendJson(res, 404, { error: "Endpoint tidak ditemukan." });
}

function renderPublicPage({ title, active, csrf, body }) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(csrf)}">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
  <script defer src="/app.js?v=${ASSET_VERSION}"></script>
</head>
<body data-page="${active === "contact" ? "contact" : "public"}">
  <header class="site-header">
    <a class="brand" href="/" aria-label="Prime Property Beranda">
      <img src="/logo-prime.png" alt="Prime Property">
    </a>
    <nav class="site-nav" aria-label="Navigasi utama">
      <a class="${active === "home" ? "active" : ""}" href="/">Beranda</a>
      <a class="${active === "about" ? "active" : ""}" href="/about">Tentang Kami</a>
      <a class="${active === "contact" ? "active" : ""}" href="/contact">Kontak</a>
    </nav>
    <a class="btn outline gold login-link" href="/agent/login">Login Agent</a>
  </header>
  <main>
    ${body}
  </main>
  <footer class="site-footer">
    <div>
      <img src="/logo-prime.png" alt="Prime Property" class="footer-logo">
      <p>Partner properti ruko dan villa dengan data listing ringkas, jelas, dan siap ditindaklanjuti.</p>
    </div>
    <div>
      <strong>Kontak</strong>
      <p>Telp/WA: <a href="https://wa.me/6281234567890">+62 812-3456-7890</a></p>
      <p>Email: <a href="mailto:admin@primeproperty.local">admin@primeproperty.local</a></p>
    </div>
    <div>
      <strong>Navigasi</strong>
      <p><a href="/about">Tentang Kami</a></p>
      <p><a href="/contact">Kontak</a></p>
    </div>
  </footer>
  <div id="toast-root" aria-live="polite" aria-atomic="true"></div>
</body>
</html>`;
}

function renderLanding(featured) {
  return `<section class="hero">
    <div class="hero-content">
      <p class="eyebrow">Prime Property Medan</p>
      <h1>Properti pilihan dengan data yang rapi dan keputusan yang lebih cepat.</h1>
      <p>Temukan ruko dan villa siap jual melalui listing ringkas, transparan, dan dikelola langsung oleh tim Prime Property.</p>
      <a class="btn primary" href="#properti-unggulan">Lihat Properti</a>
    </div>
  </section>

  <section class="content-band" id="properti-unggulan">
    <div class="section-heading">
      <p class="eyebrow">Listing Pilihan</p>
      <h2>Properti Unggulan</h2>
    </div>
    <div class="featured-grid">
      ${featured
        .map(
          (item) => `<article class="property-card">
        <div>
          <span class="badge stock">In Stock</span>
          <h3>${escapeHtml(item.nama_property)}</h3>
          <p>${escapeHtml(item.kawasan.join(", "))}</p>
        </div>
        <dl>
          <div><dt>Ukuran</dt><dd>${item.lebar} x ${item.panjang} m</dd></div>
          <div><dt>Tipe</dt><dd>${escapeHtml(item.tipe)}</dd></div>
          <div><dt>Harga</dt><dd>${formatRupiah(item.price)}</dd></div>
        </dl>
      </article>`
        )
        .join("")}
    </div>
  </section>

  <section class="content-band soft">
    <div class="section-heading">
      <p class="eyebrow">Mengapa Prime Property</p>
      <h2>Ringkas untuk pembeli, lengkap untuk tim.</h2>
    </div>
    <div class="value-grid">
      <article><span class="icon-box">✓</span><h3>Data Terstruktur</h3><p>Dimensi, kawasan, status, kesiapan, dan harga tampil konsisten.</p></article>
      <article><span class="icon-box">⌕</span><h3>Pencarian Cepat</h3><p>Listing mudah dipindai lewat filter kawasan, harga, hadap, dan tipe.</p></article>
      <article><span class="icon-box">↗</span><h3>Lokasi Jelas</h3><p>Link Maps tersedia pada properti yang sudah memiliki titik lokasi.</p></article>
      <article><span class="icon-box">⚑</span><h3>Tim Internal Siap</h3><p>Portal agent menjaga data listing tetap rapi melalui role dan audit log.</p></article>
    </div>
  </section>`;
}

function renderAbout() {
  return `<section class="page-hero compact-hero">
    <p class="eyebrow">Tentang Kami</p>
    <h1>Prime Property membantu pembeli menemukan properti yang datanya jelas sejak awal.</h1>
  </section>
  <section class="about-layout">
    <div>
      <h2>Profil Prime Property</h2>
      <p>Prime Property adalah platform listing dan operasional internal untuk properti ruko dan villa. Kami mengutamakan data yang lengkap, ringkas, dan mudah diverifikasi agar proses pencarian dan tindak lanjut berjalan lebih cepat.</p>
      <h2>Visi</h2>
      <p>Menjadi partner properti terpercaya yang menghubungkan pembeli dengan aset terbaik melalui informasi yang akurat dan mudah dipahami.</p>
      <h2>Misi</h2>
      <p>Mengelola listing dengan standar data yang konsisten, mempercepat proses pencarian properti, dan menjaga transparansi status setiap unit.</p>
    </div>
    <aside class="quote-panel">
      <img src="/hero-property.svg" alt="Ilustrasi properti Prime Property">
      <blockquote>“Properti yang baik dimulai dari data yang bisa dipercaya.”</blockquote>
      <div class="values">
        <span>Transparan</span>
        <span>Responsif</span>
        <span>Terstruktur</span>
      </div>
    </aside>
  </section>`;
}

function renderContact() {
  return `<section class="page-hero compact-hero">
    <p class="eyebrow">Kontak</p>
    <h1>Bicarakan kebutuhan properti Anda dengan tim Prime Property.</h1>
  </section>
  <section class="contact-layout">
    <div class="contact-info">
      <h2>Informasi Kontak</h2>
      <p><strong>Alamat</strong><br>Jl. Properti Utama No. 24, Medan, Sumatera Utara</p>
      <p><strong>Telepon</strong><br><a href="tel:+6281234567890">+62 812-3456-7890</a></p>
      <p><strong>Email</strong><br><a href="mailto:admin@primeproperty.local">admin@primeproperty.local</a></p>
      <p><strong>WhatsApp</strong><br><a href="https://wa.me/6281234567890">wa.me/6281234567890</a></p>
      <iframe title="Lokasi kantor Prime Property" src="https://www.google.com/maps?q=Medan%20Sumatera%20Utara&output=embed" loading="lazy"></iframe>
    </div>
    <form class="contact-form" id="contactForm" novalidate>
      <h2>Form Kontak</h2>
      <label>Nama<input name="name" autocomplete="name" required></label>
      <p class="field-error" data-error-for="name"></p>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <p class="field-error" data-error-for="email"></p>
      <label>Nomor HP<input name="phone" inputmode="tel" autocomplete="tel" required></label>
      <p class="field-error" data-error-for="phone"></p>
      <label>Pesan<textarea name="message" rows="5" required></textarea></label>
      <p class="field-error" data-error-for="message"></p>
      <button class="btn primary" type="submit">Kirim Pesan</button>
    </form>
  </section>`;
}

function renderLoginPage(csrf) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(csrf)}">
  <title>Login Agent | Prime Property</title>
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
  <script defer src="/app.js?v=${ASSET_VERSION}"></script>
</head>
<body data-page="login" class="login-page">
  <main class="login-shell">
    <section class="login-card">
      <img src="/logo-prime.png" alt="Prime Property">
      <h1>Login Agent</h1>
      <form id="loginForm" novalidate>
        <label>Email<input type="email" name="email" autocomplete="username" required></label>
        <p class="field-error" data-error-for="email"></p>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <p class="field-error" data-error-for="password"></p>
        <p class="form-message" id="loginMessage"></p>
        <button class="btn primary full" type="submit">Masuk</button>
      </form>
    </section>
  </main>
  <div id="toast-root" aria-live="polite" aria-atomic="true"></div>
</body>
</html>`;
}

function renderDashboardPage(csrf) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(csrf)}">
  <title>Dashboard Agent | Prime Property</title>
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
  <script defer src="/app.js?v=${ASSET_VERSION}"></script>
</head>
<body data-page="dashboard">
  <div id="agentApp" class="agent-app">
    <div class="loading-state">Memuat dashboard...</div>
  </div>
  <div id="toast-root" aria-live="polite" aria-atomic="true"></div>
</body>
</html>`;
}

async function serveStatic(url, res) {
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  if (!safePath || safePath.startsWith("..")) return false;

  const filePath = path.resolve(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath);
    const contentType = CONTENT_TYPES[ext] || "application/octet-stream";
    const data = await fs.readFile(filePath);
    res.writeHead(200, { ...standardHeaders(), "Content-Type": contentType, "Cache-Control": "public, max-age=3600" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function ensureData() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const usersPath = dataPath("users.json");
  if (!(await exists(usersPath))) {
    await writeJson("users.json", {
      users: [
        {
          id: "user-superadmin",
          name: "Superadmin Prime",
          email: "superadmin@primeproperty.local",
          role: "superadmin",
          enabled: true,
          password_hash: await hashPassword("PrimeSuper123!"),
          failed_logins: [],
          lockout_until: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        {
          id: "user-admin",
          name: "Admin Listing",
          email: "admin@primeproperty.local",
          role: "admin",
          enabled: true,
          password_hash: await hashPassword("PrimeAdmin123!"),
          failed_logins: [],
          lockout_until: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ]
    });
  }

  const propertiesPath = dataPath("properties.json");
  if (!(await exists(propertiesPath))) {
    await writeJson("properties.json", { properties: seedProperties() });
  }

  const requiredFiles = {
    "sessions.json": { sessions: [] },
    "audit_logs.json": { logs: [] },
    "contact_messages.json": { messages: [] },
    "contact_outbox.json": { notifications: [] }
  };

  for (const [file, fallback] of Object.entries(requiredFiles)) {
    if (!(await exists(dataPath(file)))) {
      await writeJson(file, fallback);
    }
  }
}

function seedProperties() {
  const names = [
    "Aston Villas",
    "Banyan Tree",
    "Mentari Avenue",
    "Permai 123",
    "Project Ville",
    "Cemara Garden",
    "Krakatau Square",
    "Pancing Point",
    "Helvetia Prime",
    "Sunggal Terrace",
    "Johor Residence",
    "Amplas Walk"
  ];
  const groups = ["Mentari", "Permai 123", "Project Ville", "Prime Cluster", "Golden Row", null];
  const units = ["Ready Siap huni", "Gate siap", "Lapangan", "Rucon", "Hook", null];
  const lebar = [4, 4.25, 4.5, 5, 6, 7];
  const panjang = [11, 14, 17.8, 21.5, 24, 28];
  const tingkat = [1, 2, 2.5, 3, 3.5];
  const hadapCombos = [["Utara"], ["Selatan"], ["Timur"], ["Barat"], ["Utara", "Timur"], ["Selatan", "Barat"]];
  const siap = ["siap_huni", "siap_kosong", "siap_huni_renovasi"];

  return Array.from({ length: 60 }, (_, index) => {
    const i = index + 1;
    const kawasan = [
      ENUMS.kawasan[index % ENUMS.kawasan.length],
      ...(index % 5 === 0 ? [ENUMS.kawasan[(index + 3) % ENUMS.kawasan.length]] : [])
    ];
    const created = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString();

    return {
      id: `prop-${String(i).padStart(3, "0")}`,
      nama_property: `${names[index % names.length]} ${index % 2 === 0 ? "Blok" : "Unit"} ${String.fromCharCode(65 + (index % 6))}${i}`,
      group: groups[index % groups.length],
      lebar: lebar[index % lebar.length],
      panjang: panjang[(index + 2) % panjang.length],
      hadap: hadapCombos[index % hadapCombos.length],
      tipe: index % 4 === 0 ? "Villa" : "Ruko",
      tingkat: tingkat[index % tingkat.length],
      price: 850000000 + i * 35000000 + (index % 4) * 125000000,
      carport: index % 3 !== 0,
      status: index % 7 === 0 ? "sold_out" : "in_stock",
      siap: siap[index % siap.length],
      maps_link: `https://www.google.com/maps/search/?api=1&query=Prime+Property+Medan+${i}`,
      kawasan,
      unit: units[index % units.length],
      created_at: created,
      updated_at: created,
      created_by: "user-superadmin",
      deleted_at: null
    };
  });
}

function validateProperty(body) {
  const errors = {};
  const value = {};

  value.nama_property = cleanText(body.nama_property, 100);
  if (value.nama_property.length < 3) errors.nama_property = "Nama properti minimal 3 karakter.";
  if (value.nama_property.length > 100) errors.nama_property = "Nama properti maksimal 100 karakter.";

  value.group = nullableText(body.group, 100);
  value.unit = nullableText(body.unit, 100);

  value.lebar = parseDecimal(body.lebar);
  if (!(value.lebar > 0)) errors.lebar = "Lebar harus lebih dari 0.";
  if (!hasMaxDecimals(body.lebar, 2)) errors.lebar = "Lebar maksimal 2 desimal.";

  value.panjang = parseDecimal(body.panjang);
  if (!(value.panjang > 0)) errors.panjang = "Panjang harus lebih dari 0.";
  if (!hasMaxDecimals(body.panjang, 2)) errors.panjang = "Panjang maksimal 2 desimal.";

  value.tingkat = parseDecimal(body.tingkat);
  if (!(value.tingkat >= 1 && value.tingkat <= 10)) errors.tingkat = "Tingkat harus antara 1 sampai 10.";
  if (!hasMaxDecimals(body.tingkat, 1)) errors.tingkat = "Tingkat maksimal 1 desimal.";

  value.price = parsePrice(body.price);
  if (!(value.price > 0)) errors.price = "Harga harus lebih dari 0.";
  if (!Number.isInteger(value.price)) errors.price = "Harga harus berupa integer rupiah.";

  value.carport = body.carport === true || body.carport === "true" || body.carport === "on";

  value.hadap = normalizeArray(body.hadap);
  if (!value.hadap.length) errors.hadap = "Pilih minimal satu hadap.";
  if (!value.hadap.every((item) => ENUMS.hadap.includes(item))) errors.hadap = "Hadap tidak valid.";

  value.kawasan = normalizeArray(body.kawasan);
  if (!value.kawasan.length) errors.kawasan = "Pilih minimal satu kawasan.";
  if (!value.kawasan.every((item) => ENUMS.kawasan.includes(item))) errors.kawasan = "Kawasan tidak valid.";

  value.tipe = cleanText(body.tipe, 20);
  if (!ENUMS.tipe.includes(value.tipe)) errors.tipe = "Tipe tidak valid.";

  value.status = cleanText(body.status, 20);
  if (!ENUMS.status.includes(value.status)) errors.status = "Status tidak valid.";

  value.siap = cleanText(body.siap, 40);
  if (!ENUMS.siap.includes(value.siap)) errors.siap = "Kesiapan tidak valid.";

  value.maps_link = nullableText(body.maps_link, 500);
  if (value.maps_link && !isValidMapsUrl(value.maps_link)) {
    errors.maps_link = "Maps link harus URL valid dari google.com/maps.";
  }

  return { value, errors };
}

function validateContact(body) {
  const errors = {};
  const name = cleanText(body.name, 100);
  const email = cleanText(body.email, 160).toLowerCase();
  const phone = cleanText(body.phone, 32);
  const message = cleanText(body.message, 1500);

  if (!name) errors.name = "Nama wajib diisi.";
  if (!email) errors.email = "Email wajib diisi.";
  if (email && !isValidEmail(email)) errors.email = "Format email tidak valid.";
  if (!phone) errors.phone = "Nomor HP wajib diisi.";
  if (phone.replace(/\D/g, "").length < 10) errors.phone = "Nomor HP minimal 10 digit.";
  if (!message) errors.message = "Pesan wajib diisi.";

  return errors;
}

async function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const sessionsStore = await readJson("sessions.json", { sessions: [] });
  const session = sessionsStore.sessions.find((item) => item.id === sessionId);
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;

  const usersStore = await readJson("users.json", { users: [] });
  const user = usersStore.users.find((item) => item.id === session.user_id && item.enabled);
  if (!user) return null;

  return { ...session, user };
}

function requireSuperadmin(res, user) {
  if (user.role !== "superadmin") {
    sendJson(res, 403, { error: "Forbidden: role admin tidak memiliki izin mutasi." });
    return false;
  }
  return true;
}

async function hashPassword(password) {
  if (bcrypt) {
    return bcrypt.hash(password, 10);
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$N=16384$r=8$p=1$${salt}$${hash}`;
}

async function verifyPassword(password, storedHash) {
  if (storedHash.startsWith("$2") && bcrypt) {
    return bcrypt.compare(password, storedHash);
  }
  if (storedHash.startsWith("scrypt$")) {
    const parts = storedHash.split("$");
    const salt = parts[4];
    const expected = parts[5];
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return safeCompare(hash, expected);
  }
  return false;
}

function ensureCsrf(req, res) {
  const cookies = parseCookies(req);
  const existing = cookies[CSRF_COOKIE];
  if (existing && existing.length >= 32) return existing;

  const token = crypto.randomBytes(32).toString("hex");
  setCookie(res, CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "Lax",
    maxAge: Math.floor(THIRTY_DAYS / 1000),
    secure: IS_PROD,
    path: "/"
  });
  return token;
}

function requireCsrf(req, res, body = {}) {
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const requestToken = req.headers["x-csrf-token"] || body._csrf;

  if (!cookieToken || !requestToken || !safeCompare(String(cookieToken), String(requestToken))) {
    sendJson(res, 403, { error: "CSRF token tidak valid." });
    return false;
  }
  return true;
}

function consumeRateLimit(req, res, bucket, limit, windowMs) {
  const now = Date.now();
  const key = `${bucket}:${getIp(req)}`;
  const history = (rateBuckets.get(key) || []).filter((time) => now - time < windowMs);
  if (history.length >= limit) {
    res.writeHead(429, {
      ...standardHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(Math.ceil(windowMs / 1000))
    });
    res.end(JSON.stringify({ error: "Terlalu banyak request. Coba lagi nanti." }));
    return false;
  }
  history.push(now);
  rateBuckets.set(key, history);
  return true;
}

async function addAudit(actor, action, entityId, changes) {
  const logs = await readJson("audit_logs.json", { logs: [] });
  logs.logs.unshift({
    id: crypto.randomUUID(),
    action,
    entity_id: entityId,
    actor: {
      id: actor.id,
      name: actor.name,
      email: actor.email,
      role: actor.role
    },
    changes,
    created_at: new Date().toISOString()
  });
  await writeJson("audit_logs.json", logs);
}

function diffProperty(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    if (["updated_at"].includes(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { before: before[key], after: after[key] };
    }
  }
  return changes;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    enabled: user.enabled,
    last_login_at: user.last_login_at || null,
    created_at: user.created_at,
    updated_at: user.updated_at
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  const existing = res.getHeader("Set-Cookie");
  const next = Array.isArray(existing) ? existing.concat(parts.join("; ")) : [parts.join("; ")];
  res.setHeader("Set-Cookie", next);
}

function clearCookie(res, name) {
  setCookie(res, name, "", {
    maxAge: 0,
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: IS_PROD
  });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body terlalu besar.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  const type = req.headers["content-type"] || "";
  if (type.includes("application/json")) return JSON.parse(raw);
  if (type.includes("application/x-www-form-urlencoded")) return querystring.parse(raw);
  return { raw };
}

async function readJson(file, fallback) {
  try {
    const data = await fs.readFile(dataPath(file), "utf8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, data) {
  const target = dataPath(file);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
}

function dataPath(file) {
  return path.join(DATA_DIR, file);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { ...standardHeaders(), "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    ...standardHeaders(),
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { ...standardHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { ...standardHeaders(), Location: location });
  res.end();
}

function standardHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data:; frame-src https://www.google.com; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'"
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => cleanText(item, 80)).filter(Boolean))];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => cleanText(item, 80))
      .filter(Boolean);
  }
  return [];
}

function cleanText(value, max = 255) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function nullableText(value, max = 255) {
  const text = cleanText(value, max);
  return text || null;
}

function parseDecimal(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(String(value).replace(",", "."));
}

function parsePrice(value) {
  if (typeof value === "number") return value;
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? Number(digits) : NaN;
}

function hasMaxDecimals(value, max) {
  const text = String(value ?? "").replace(",", ".");
  if (!text.includes(".")) return true;
  return text.split(".")[1].length <= max;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidMapsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith("google.com") && url.pathname.startsWith("/maps");
  } catch {
    return false;
  }
}

function formatRupiah(value) {
  return `Rp ${Number(value || 0)
    .toLocaleString("id-ID", { maximumFractionDigits: 0 })
    .replace(/,/g, ".")}`;
}

function safeCompare(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function generateTemporaryPassword() {
  return `Prime-${crypto.randomBytes(6).toString("base64url")}1!`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
