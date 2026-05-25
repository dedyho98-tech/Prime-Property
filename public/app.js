const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";

const OPTIONS = {
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

const LABELS = {
  in_stock: "In Stock",
  sold_out: "Sold Out",
  siap_huni: "Siap Huni",
  siap_kosong: "Siap Kosong",
  siap_huni_renovasi: "Siap Huni Renovasi"
};

let dashboardState = null;
let debounceTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "contact") initContact();
  if (page === "login") initLogin();
  if (page === "dashboard") initDashboard();
});

function initContact() {
  const form = document.querySelector("#contactForm");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors(form);
    const body = Object.fromEntries(new FormData(form).entries());
    const errors = validateContact(body);
    if (Object.keys(errors).length) {
      showErrors(form, errors);
      return;
    }

    try {
      const result = await api("/api/contact", { method: "POST", body });
      form.reset();
      toast(result.message || "Pesan terkirim, tim kami akan menghubungi Anda.");
    } catch (error) {
      showErrors(form, error.data?.errors || {});
      toast(error.message, true);
    }
  });
}

function initLogin() {
  const form = document.querySelector("#loginForm");
  const message = document.querySelector("#loginMessage");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearErrors(form);
    message.textContent = "";
    const body = Object.fromEntries(new FormData(form).entries());

    if (!body.email) setFieldError(form, "email", "Email wajib diisi.");
    if (!body.password) setFieldError(form, "password", "Password wajib diisi.");
    if (!body.email || !body.password) return;

    try {
      const result = await api("/api/auth/login", { method: "POST", body });
      window.location.href = result.redirect || "/agent";
    } catch (error) {
      message.textContent = error.message;
    }
  });
}

async function initDashboard() {
  try {
    const [meResult, propertiesResult] = await Promise.all([api("/api/auth/me"), api("/api/properties")]);
    dashboardState = {
      user: meResult.user,
      properties: propertiesResult.properties,
      users: [],
      auditLogs: [],
      activeTab: "properties",
      filters: readFiltersFromUrl(),
      selectedId: null
    };

    renderDashboardFrame();
    bindDashboardFrame();
    renderPropertiesView();

    if (isSuperadmin()) {
      await loadSuperadminData();
      renderAdminView();
      renderAuditView();
    }
  } catch (error) {
    const app = document.querySelector("#agentApp");
    app.innerHTML = `<div class="loading-state"><p>${escapeHtml(error.message)}</p><a class="btn primary" href="/agent/login">Login Ulang</a></div>`;
  }
}

function renderDashboardFrame() {
  const app = document.querySelector("#agentApp");
  const adminTabs = isSuperadmin()
    ? `<button class="tab-button" data-tab="admin">Admin</button><button class="tab-button" data-tab="audit">Audit Log</button>`
    : "";

  app.innerHTML = `
    <header class="internal-header">
      <a class="brand" href="/agent" aria-label="Dashboard Prime Property">
        <img src="/logo-prime.png" alt="Prime Property">
      </a>
      <nav class="tab-nav" aria-label="Navigasi dashboard">
        <button class="tab-button active" data-tab="properties">Properti</button>
        ${adminTabs}
      </nav>
      <div class="profile-menu">
        <button class="profile-button" id="profileButton" type="button">${escapeHtml(dashboardState.user.name)} - ${escapeHtml(dashboardState.user.role)}</button>
        <div class="profile-dropdown" id="profileDropdown" hidden>
          <p>${escapeHtml(dashboardState.user.email)}</p>
          <button class="btn outline full" id="logoutButton" type="button">Logout</button>
        </div>
      </div>
    </header>
    <main class="dashboard-page">
      <section id="propertiesView"></section>
      <section id="adminView" hidden></section>
      <section id="auditView" hidden></section>
    </main>
    <aside class="detail-drawer" id="detailDrawer" aria-hidden="true"></aside>
    <dialog class="modal" id="propertyModal"></dialog>
    <dialog class="modal" id="deleteModal"></dialog>
  `;
}

function bindDashboardFrame() {
  document.querySelector("#profileButton").addEventListener("click", () => {
    const menu = document.querySelector("#profileDropdown");
    menu.hidden = !menu.hidden;
  });

  document.querySelector("#logoutButton").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: {} });
    window.location.href = "/agent/login";
  });

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
}

function switchTab(tab) {
  dashboardState.activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelector("#propertiesView").hidden = tab !== "properties";
  const adminView = document.querySelector("#adminView");
  const auditView = document.querySelector("#auditView");
  if (adminView) adminView.hidden = tab !== "admin";
  if (auditView) auditView.hidden = tab !== "audit";
}

function renderPropertiesView() {
  const view = document.querySelector("#propertiesView");
  view.innerHTML = `
    <div class="dashboard-layout">
      <aside class="panel filter-panel">
        <h2>Filter</h2>
        <div class="filter-grid">
          <label>Kawasan
            <select id="filterKawasan" multiple size="5">${OPTIONS.kawasan.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("")}</select>
          </label>
          <label>Lebar min (m)<input id="filterLebarMin" type="number" min="0" step="0.01" inputmode="decimal"></label>
          <label>Hadap
            <select id="filterHadap" multiple size="4">${OPTIONS.hadap.map((item) => `<option value="${item}">${item}</option>`).join("")}</select>
          </label>
          <label>Harga Max<input id="filterPriceMax" inputmode="numeric" placeholder="Rp 1.500.000.000"></label>
          <label>Tipe</label>
          <div class="segmented" data-radio-group="tipe">
            ${radioOption("tipe", "all", "Semua")}
            ${radioOption("tipe", "Ruko", "Ruko")}
            ${radioOption("tipe", "Villa", "Villa")}
          </div>
          <label>Status</label>
          <div class="segmented" data-radio-group="status">
            ${radioOption("status", "all", "Semua")}
            ${radioOption("status", "in_stock", "In Stock")}
            ${radioOption("status", "sold_out", "Sold Out")}
          </div>
          <label>Siap
            <select id="filterSiap" multiple size="3">${OPTIONS.siap.map((item) => `<option value="${item}">${LABELS[item]}</option>`).join("")}</select>
          </label>
          <label>Carport</label>
          <div class="segmented" data-radio-group="carport">
            ${radioOption("carport", "all", "Semua")}
            ${radioOption("carport", "true", "Ya")}
            ${radioOption("carport", "false", "Tidak")}
          </div>
          <button class="btn outline" id="resetFilters" type="button">Reset Filter</button>
        </div>
      </aside>
      <section class="surface">
        <div class="listing-toolbar">
          <input id="searchInput" placeholder="Cari nama, group, kawasan" aria-label="Search properti">
          <select id="sortSelect" aria-label="Sort properti">
            <option value="nama_property:asc">Nama A-Z</option>
            <option value="nama_property:desc">Nama Z-A</option>
            <option value="price:asc">Harga Terendah</option>
            <option value="price:desc">Harga Tertinggi</option>
            <option value="created_at:desc">Terbaru</option>
            <option value="created_at:asc">Terlama</option>
            <option value="status:asc">Status A-Z</option>
            <option value="status:desc">Status Z-A</option>
          </select>
          <select id="pageSizeSelect" aria-label="Jumlah baris">
            <option value="25">25 baris</option>
            <option value="50">50 baris</option>
            <option value="100">100 baris</option>
          </select>
          ${isSuperadmin() ? `<button class="btn primary" id="addProperty" type="button">+ Tambah Properti</button>` : ""}
        </div>
        <div class="chip-row" id="filterChips"></div>
        <p class="results-meta" id="resultsMeta"></p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nama</th>
                <th>Group</th>
                <th>Lebar x Panjang</th>
                <th>Hadap</th>
                <th>Tipe</th>
                <th>Tingkat</th>
                <th>Harga</th>
                <th>Carport</th>
                <th>Status</th>
                <th>Siap</th>
                <th>Kawasan</th>
              </tr>
            </thead>
            <tbody id="propertiesTableBody"></tbody>
          </table>
        </div>
        <div class="pagination" id="pagination"></div>
      </section>
    </div>
  `;

  bindPropertyEvents();
  syncFilterControls();
  renderPropertyTable();
}

function bindPropertyEvents() {
  const filterIds = ["filterKawasan", "filterHadap", "filterSiap", "filterLebarMin", "filterPriceMax"];
  filterIds.forEach((id) => {
    document.querySelector(`#${id}`).addEventListener("input", () => {
      dashboardState.filters[idToFilterKey(id)] = readControlValue(id);
      dashboardState.filters.page = 1;
      scheduleFilterApply();
    });
  });

  document.querySelector("#searchInput").addEventListener("input", (event) => {
    dashboardState.filters.search = event.target.value;
    dashboardState.filters.page = 1;
    scheduleFilterApply();
  });

  document.querySelector("#sortSelect").addEventListener("change", (event) => {
    dashboardState.filters.sort = event.target.value;
    dashboardState.filters.page = 1;
    applyFilters();
  });

  document.querySelector("#pageSizeSelect").addEventListener("change", (event) => {
    dashboardState.filters.pageSize = Number(event.target.value);
    dashboardState.filters.page = 1;
    applyFilters();
  });

  document.querySelectorAll("[data-radio-group] input").forEach((input) => {
    input.addEventListener("change", () => {
      dashboardState.filters[input.name] = input.value;
      dashboardState.filters.page = 1;
      scheduleFilterApply();
    });
  });

  document.querySelector("#resetFilters").addEventListener("click", () => {
    dashboardState.filters = defaultFilters();
    syncFilterControls();
    applyFilters();
  });

  document.querySelector("#filterChips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-chip]");
    if (!button) return;
    removeChip(button.dataset.chip, button.dataset.value);
  });

  document.querySelector("#propertiesTableBody").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-id]");
    if (row) openDrawer(row.dataset.id);
  });

  const addButton = document.querySelector("#addProperty");
  if (addButton) addButton.addEventListener("click", () => showPropertyForm("create"));
}

function renderPropertyTable() {
  const filtered = filterProperties();
  const pages = Math.max(1, Math.ceil(filtered.length / dashboardState.filters.pageSize));
  dashboardState.filters.page = Math.min(Math.max(1, dashboardState.filters.page), pages);
  const start = (dashboardState.filters.page - 1) * dashboardState.filters.pageSize;
  const pageItems = filtered.slice(start, start + dashboardState.filters.pageSize);

  document.querySelector("#filterChips").innerHTML = renderChips();
  document.querySelector("#resultsMeta").textContent = `${filtered.length} properti ditemukan. Halaman ${dashboardState.filters.page} dari ${pages}.`;
  document.querySelector("#propertiesTableBody").innerHTML = pageItems.length
    ? pageItems.map(renderPropertyRow).join("")
    : `<tr><td colspan="11" class="empty-state">Tidak ada properti yang cocok.</td></tr>`;
  document.querySelector("#pagination").innerHTML = `
    <button class="btn outline" type="button" data-page-action="prev" ${dashboardState.filters.page <= 1 ? "disabled" : ""}>Sebelumnya</button>
    <button class="btn outline" type="button" data-page-action="next" ${dashboardState.filters.page >= pages ? "disabled" : ""}>Berikutnya</button>
  `;
  document.querySelector("#pagination").onclick = (event) => {
    const action = event.target.closest("[data-page-action]")?.dataset.pageAction;
    if (!action) return;
    dashboardState.filters.page += action === "next" ? 1 : -1;
    applyFilters();
  };
}

function renderPropertyRow(item) {
  const highlight = dashboardState.filters.highlight === item.id ? " highlight" : "";
  return `<tr data-id="${escapeHtml(item.id)}" class="${highlight}">
    <td><strong>${escapeHtml(item.nama_property)}</strong></td>
    <td>${escapeHtml(item.group || "-")}</td>
    <td>${item.lebar} x ${item.panjang} m</td>
    <td>${escapeHtml(item.hadap.join(", "))}</td>
    <td>${escapeHtml(item.tipe)}</td>
    <td>${item.tingkat}</td>
    <td>${formatRupiah(item.price)}</td>
    <td>${item.carport ? "Ya" : "Tidak"}</td>
    <td>${statusBadge(item.status)}</td>
    <td>${siapBadge(item.siap)}</td>
    <td>${escapeHtml(item.kawasan.join(", "))}</td>
  </tr>`;
}

function openDrawer(id) {
  const item = dashboardState.properties.find((property) => property.id === id);
  if (!item) return;
  dashboardState.selectedId = id;
  const drawer = document.querySelector("#detailDrawer");
  const actions = isSuperadmin()
    ? `<button class="btn primary" id="editProperty" type="button">Edit</button><button class="btn danger" id="deleteProperty" type="button">Hapus</button>`
    : "";
  const mapsButton = item.maps_link
    ? `<a class="btn outline gold" href="${escapeHtml(item.maps_link)}" target="_blank" rel="noopener">Buka di Google Maps</a>`
    : "";

  drawer.innerHTML = `
    <div class="drawer-header">
      <div>
        <p class="eyebrow">Detail Properti</p>
        <h2>${escapeHtml(item.nama_property)}</h2>
      </div>
      <button class="icon-btn" id="closeDrawer" type="button" aria-label="Tutup">x</button>
    </div>
    <div class="drawer-actions">${actions}${mapsButton}</div>
    <div class="detail-grid">
      ${detailItem("Nama", item.nama_property)}
      ${detailItem("Group", item.group || "-")}
      ${detailItem("Lebar", `${item.lebar} m`)}
      ${detailItem("Panjang", `${item.panjang} m`)}
      ${detailItem("Hadap", item.hadap.join(", "))}
      ${detailItem("Tipe", item.tipe)}
      ${detailItem("Tingkat", item.tingkat)}
      ${detailItem("Harga", formatRupiah(item.price))}
      ${detailItem("Carport", item.carport ? "Ya" : "Tidak")}
      ${detailItem("Status", LABELS[item.status])}
      ${detailItem("Siap", LABELS[item.siap])}
      ${detailItem("Kawasan", item.kawasan.join(", "))}
      ${detailItem("Unit", item.unit || "-")}
      ${detailItem("Maps", item.maps_link || "-")}
      ${detailItem("Dibuat", formatDate(item.created_at))}
      ${detailItem("Diupdate", formatDate(item.updated_at))}
    </div>
  `;

  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.querySelector("#closeDrawer").addEventListener("click", closeDrawer);
  const editButton = document.querySelector("#editProperty");
  const deleteButton = document.querySelector("#deleteProperty");
  if (editButton) editButton.addEventListener("click", () => showPropertyForm("edit", item.id));
  if (deleteButton) deleteButton.addEventListener("click", () => confirmDelete(item.id));
}

function closeDrawer() {
  const drawer = document.querySelector("#detailDrawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  dashboardState.selectedId = null;
}

function showPropertyForm(mode, id = null) {
  const modal = document.querySelector("#propertyModal");
  const editing = mode === "edit" ? dashboardState.properties.find((item) => item.id === id) : null;
  const initial = editing || emptyProperty();
  modal.innerHTML = `
    <div class="modal-shell">
      <div class="modal-header">
        <h2>${mode === "edit" ? "Edit Properti" : "Tambah Properti"}</h2>
        <button class="icon-btn" type="button" data-close-modal aria-label="Tutup">x</button>
      </div>
      <form id="propertyForm" novalidate>
        <div class="form-grid">
          ${textField("nama_property", "Nama Properti", initial.nama_property, true)}
          ${textField("group", "Group", initial.group || "", false)}
          ${numberField("lebar", "Lebar (m)", initial.lebar, "0.01")}
          ${numberField("panjang", "Panjang (m)", initial.panjang, "0.01")}
          ${selectField("tipe", "Tipe", OPTIONS.tipe, initial.tipe)}
          ${numberField("tingkat", "Tingkat", initial.tingkat, "0.1")}
          ${textField("price", "Harga", initial.price ? String(initial.price) : "", true, "numeric")}
          ${selectField("status", "Status", OPTIONS.status, initial.status, LABELS)}
          ${selectField("siap", "Siap", OPTIONS.siap, initial.siap, LABELS)}
          <label data-field="carport">Carport <span class="dirty-mark">Diubah</span><input type="checkbox" name="carport" ${initial.carport ? "checked" : ""}></label>
          ${checkboxGroup("hadap", "Hadap", OPTIONS.hadap, initial.hadap)}
          ${checkboxGroup("kawasan", "Kawasan", OPTIONS.kawasan, initial.kawasan)}
          ${textField("unit", "Unit", initial.unit || "", false)}
          ${textField("maps_link", "Maps Link", initial.maps_link || "", false)}
        </div>
        <div class="modal-actions">
          <button class="btn outline" type="button" data-close-modal>Batal</button>
          ${mode === "create" ? `<button class="btn outline gold" type="submit" data-save-again="true">Simpan & Tambah Lagi</button>` : ""}
          <button class="btn primary" type="submit">${mode === "edit" ? "Simpan Perubahan" : "Simpan"}</button>
        </div>
      </form>
    </div>
  `;

  modal.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => modal.close()));
  const form = modal.querySelector("#propertyForm");
  const original = normalizePropertyForCompare(initial);

  form.addEventListener("input", () => markDirtyFields(form, original));
  form.addEventListener("change", () => markDirtyFields(form, original));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const saveAgain = event.submitter?.dataset.saveAgain === "true";
    const payload = collectPropertyForm(form);
    const errors = validatePropertyPayload(payload);
    clearErrors(form);
    if (Object.keys(errors).length) {
      showErrors(form, errors);
      return;
    }

    try {
      const result = await api(mode === "edit" ? `/api/properties/${id}` : "/api/properties", {
        method: mode === "edit" ? "PUT" : "POST",
        body: payload
      });
      await refreshProperties();
      dashboardState.filters.highlight = result.property.id;
      writeFiltersToUrl();
      syncFilterControls();
      renderPropertyTable();
      if (dashboardState.selectedId === result.property.id) openDrawer(result.property.id);
      toast(mode === "edit" ? "Properti berhasil diperbarui." : "Properti berhasil ditambahkan.");
      if (saveAgain) {
        showPropertyForm("create");
      } else {
        modal.close();
      }
    } catch (error) {
      showErrors(form, error.data?.errors || {});
      toast(error.message, true);
    }
  });

  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "open");
}

function confirmDelete(id) {
  const item = dashboardState.properties.find((property) => property.id === id);
  if (!item) return;
  const modal = document.querySelector("#deleteModal");
  modal.innerHTML = `
    <div class="modal-shell">
      <div class="modal-header">
        <h2>Hapus Properti</h2>
        <button class="icon-btn" type="button" data-close-modal aria-label="Tutup">x</button>
      </div>
      <p>Yakin hapus properti ${escapeHtml(item.nama_property)}? Tindakan ini tidak dapat dibatalkan.</p>
      <div class="modal-actions">
        <button class="btn outline" type="button" data-close-modal>Batal</button>
        <button class="btn danger" id="confirmDeleteButton" type="button">Hapus</button>
      </div>
    </div>
  `;

  modal.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => modal.close()));
  modal.querySelector("#confirmDeleteButton").addEventListener("click", async () => {
    try {
      await api(`/api/properties/${id}`, { method: "DELETE", body: {} });
      await refreshProperties();
      closeDrawer();
      modal.close();
      renderPropertyTable();
      toast("Properti berhasil dihapus.");
    } catch (error) {
      toast(error.message, true);
    }
  });

  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "open");
}

async function refreshProperties() {
  const result = await api("/api/properties");
  dashboardState.properties = result.properties;
}

async function loadSuperadminData() {
  const [usersResult, auditResult] = await Promise.all([api("/api/users"), api("/api/audit-logs")]);
  dashboardState.users = usersResult.users;
  dashboardState.auditLogs = auditResult.logs;
}

function renderAdminView() {
  const view = document.querySelector("#adminView");
  view.innerHTML = `
    <div class="admin-grid">
      <section class="panel admin-section">
        <h2>Buat Admin</h2>
        <form class="admin-form" id="adminForm" novalidate>
          <label>Nama<input name="name" required></label>
          <p class="field-error" data-error-for="name"></p>
          <label>Email<input type="email" name="email" required></label>
          <p class="field-error" data-error-for="email"></p>
          <label>Password<input type="password" name="password" required></label>
          <p class="field-error" data-error-for="password"></p>
          <button class="btn primary" type="submit">Buat Akun Admin</button>
        </form>
        <p class="form-message" id="adminNotice"></p>
      </section>
      <section class="surface admin-section">
        <h2>Daftar Admin</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Nama</th><th>Email</th><th>Role</th><th>Status</th><th>Aksi</th></tr></thead>
            <tbody id="usersTableBody"></tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  view.querySelector("#adminForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearErrors(form);
    const body = Object.fromEntries(new FormData(form).entries());
    const errors = {};
    if (!body.name || body.name.trim().length < 3) errors.name = "Nama minimal 3 karakter.";
    if (!isValidEmail(body.email || "")) errors.email = "Email tidak valid.";
    if (!body.password || body.password.length < 10) errors.password = "Password minimal 10 karakter.";
    if (Object.keys(errors).length) {
      showErrors(form, errors);
      return;
    }

    try {
      await api("/api/users", { method: "POST", body });
      form.reset();
      await loadSuperadminData();
      renderUsersTable();
      renderAuditView();
      toast("Akun admin berhasil dibuat.");
    } catch (error) {
      showErrors(form, error.data?.errors || {});
      toast(error.message, true);
    }
  });

  view.querySelector("#usersTableBody").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-user-action]");
    if (!button) return;
    const userId = button.dataset.userId;
    const action = button.dataset.userAction;
    try {
      if (action === "toggle") {
        await api(`/api/users/${userId}`, { method: "PATCH", body: { enabled: button.dataset.nextEnabled === "true" } });
        toast("Status admin diperbarui.");
      }
      if (action === "reset") {
        const result = await api(`/api/users/${userId}/reset-password`, { method: "POST", body: {} });
        document.querySelector("#adminNotice").textContent = `Password sementara: ${result.temporaryPassword}`;
        toast("Password admin berhasil direset.");
      }
      await loadSuperadminData();
      renderUsersTable();
      renderAuditView();
    } catch (error) {
      toast(error.message, true);
    }
  });

  renderUsersTable();
}

function renderUsersTable() {
  const body = document.querySelector("#usersTableBody");
  if (!body) return;
  body.innerHTML = dashboardState.users
    .map((user) => {
      const canToggle = user.id !== dashboardState.user.id;
      return `<tr>
        <td><strong>${escapeHtml(user.name)}</strong></td>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${user.enabled ? statusBadge("in_stock", "Aktif") : statusBadge("sold_out", "Nonaktif")}</td>
        <td>
          ${canToggle ? `<button class="btn outline" type="button" data-user-action="toggle" data-user-id="${escapeHtml(user.id)}" data-next-enabled="${String(!user.enabled)}">${user.enabled ? "Disable" : "Enable"}</button>` : ""}
          <button class="btn outline gold" type="button" data-user-action="reset" data-user-id="${escapeHtml(user.id)}">Reset Password</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderAuditView() {
  const view = document.querySelector("#auditView");
  if (!view) return;
  view.innerHTML = `
    <section class="surface">
      <h2>Audit Log</h2>
      <div class="audit-list">
        ${
          dashboardState.auditLogs.length
            ? dashboardState.auditLogs
                .map(
                  (log) => `<article class="audit-item">
            <strong>${escapeHtml(log.action)}</strong>
            <p>${escapeHtml(log.actor.name)} - ${formatDate(log.created_at)}</p>
            <pre>${escapeHtml(JSON.stringify(log.changes, null, 2))}</pre>
          </article>`
                )
                .join("")
            : `<p class="empty-state">Belum ada perubahan tercatat.</p>`
        }
      </div>
    </section>
  `;
}

function filterProperties() {
  const filters = dashboardState.filters;
  const search = filters.search.trim().toLowerCase();
  let list = dashboardState.properties.filter((item) => {
    if (search) {
      const haystack = `${item.nama_property} ${item.group || ""} ${item.kawasan.join(" ")}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (filters.kawasan.length && !filters.kawasan.some((value) => item.kawasan.includes(value))) return false;
    if (filters.hadap.length && !filters.hadap.some((value) => item.hadap.includes(value))) return false;
    if (filters.siap.length && !filters.siap.includes(item.siap)) return false;
    if (filters.lebarMin && Number(item.lebar) < Number(filters.lebarMin)) return false;
    if (filters.priceMax && Number(item.price) > parsePrice(filters.priceMax)) return false;
    if (filters.tipe !== "all" && item.tipe !== filters.tipe) return false;
    if (filters.status !== "all" && item.status !== filters.status) return false;
    if (filters.carport !== "all" && String(item.carport) !== filters.carport) return false;
    return true;
  });

  const [key, direction] = filters.sort.split(":");
  list = list.sort((left, right) => {
    const a = left[key];
    const b = right[key];
    let result = 0;
    if (key === "price") result = Number(a) - Number(b);
    else if (key === "created_at") result = Date.parse(a) - Date.parse(b);
    else result = String(a).localeCompare(String(b), "id-ID");
    return direction === "desc" ? -result : result;
  });

  return list;
}

function readFiltersFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return {
    ...defaultFilters(),
    search: params.get("search") || "",
    kawasan: params.getAll("kawasan"),
    lebarMin: params.get("lebarMin") || "",
    hadap: params.getAll("hadap"),
    priceMax: params.get("priceMax") || "",
    tipe: params.get("tipe") || "all",
    status: params.get("status") || "all",
    siap: params.getAll("siap"),
    carport: params.get("carport") || "all",
    page: Number(params.get("page") || 1),
    pageSize: Number(params.get("pageSize") || 50),
    sort: params.get("sort") || "nama_property:asc",
    highlight: params.get("highlight") || ""
  };
}

function defaultFilters() {
  return {
    search: "",
    kawasan: [],
    lebarMin: "",
    hadap: [],
    priceMax: "",
    tipe: "all",
    status: "all",
    siap: [],
    carport: "all",
    page: 1,
    pageSize: 50,
    sort: "nama_property:asc",
    highlight: ""
  };
}

function syncFilterControls() {
  const filters = dashboardState.filters;
  document.querySelector("#searchInput").value = filters.search;
  document.querySelector("#filterLebarMin").value = filters.lebarMin;
  document.querySelector("#filterPriceMax").value = filters.priceMax;
  document.querySelector("#sortSelect").value = filters.sort;
  document.querySelector("#pageSizeSelect").value = String(filters.pageSize);
  syncSelect("filterKawasan", filters.kawasan);
  syncSelect("filterHadap", filters.hadap);
  syncSelect("filterSiap", filters.siap);
  syncRadio("tipe", filters.tipe);
  syncRadio("status", filters.status);
  syncRadio("carport", filters.carport);
}

function applyFilters() {
  writeFiltersToUrl();
  renderPropertyTable();
}

function scheduleFilterApply() {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(applyFilters, 300);
}

function writeFiltersToUrl() {
  const params = new URLSearchParams();
  const filters = dashboardState.filters;
  if (filters.search) params.set("search", filters.search);
  filters.kawasan.forEach((value) => params.append("kawasan", value));
  if (filters.lebarMin) params.set("lebarMin", filters.lebarMin);
  filters.hadap.forEach((value) => params.append("hadap", value));
  if (filters.priceMax) params.set("priceMax", filters.priceMax);
  if (filters.tipe !== "all") params.set("tipe", filters.tipe);
  if (filters.status !== "all") params.set("status", filters.status);
  filters.siap.forEach((value) => params.append("siap", value));
  if (filters.carport !== "all") params.set("carport", filters.carport);
  if (filters.page !== 1) params.set("page", String(filters.page));
  if (filters.pageSize !== 50) params.set("pageSize", String(filters.pageSize));
  if (filters.sort !== "nama_property:asc") params.set("sort", filters.sort);
  if (filters.highlight) params.set("highlight", filters.highlight);
  const next = params.toString() ? `${window.location.pathname}?${params.toString()}` : window.location.pathname;
  window.history.replaceState(null, "", next);
}

function renderChips() {
  const filters = dashboardState.filters;
  const chips = [];
  if (filters.search) chips.push(["search", filters.search, `Search: ${filters.search}`]);
  filters.kawasan.forEach((value) => chips.push(["kawasan", value, `Kawasan: ${value}`]));
  if (filters.lebarMin) chips.push(["lebarMin", filters.lebarMin, `Lebar min: ${filters.lebarMin} m`]);
  filters.hadap.forEach((value) => chips.push(["hadap", value, `Hadap: ${value}`]));
  if (filters.priceMax) chips.push(["priceMax", filters.priceMax, `Harga max: ${formatRupiah(parsePrice(filters.priceMax))}`]);
  if (filters.tipe !== "all") chips.push(["tipe", filters.tipe, `Tipe: ${filters.tipe}`]);
  if (filters.status !== "all") chips.push(["status", filters.status, `Status: ${LABELS[filters.status]}`]);
  filters.siap.forEach((value) => chips.push(["siap", value, `Siap: ${LABELS[value]}`]));
  if (filters.carport !== "all") chips.push(["carport", filters.carport, `Carport: ${filters.carport === "true" ? "Ya" : "Tidak"}`]);

  return chips
    .map(
      ([key, value, label]) =>
        `<span class="chip">${escapeHtml(label)} <button type="button" data-chip="${escapeHtml(key)}" data-value="${escapeHtml(value)}" aria-label="Hapus filter">x</button></span>`
    )
    .join("");
}

function removeChip(key, value) {
  const filters = dashboardState.filters;
  if (Array.isArray(filters[key])) filters[key] = filters[key].filter((item) => item !== value);
  else filters[key] = defaultFilters()[key];
  filters.page = 1;
  syncFilterControls();
  applyFilters();
}

function collectPropertyForm(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  data.hadap = [...form.querySelectorAll('input[name="hadap"]:checked')].map((input) => input.value);
  data.kawasan = [...form.querySelectorAll('input[name="kawasan"]:checked')].map((input) => input.value);
  data.carport = form.querySelector('input[name="carport"]').checked;
  return data;
}

function validatePropertyPayload(payload) {
  const errors = {};
  if (!payload.nama_property || payload.nama_property.trim().length < 3) errors.nama_property = "Nama properti minimal 3 karakter.";
  if ((payload.nama_property || "").length > 100) errors.nama_property = "Nama properti maksimal 100 karakter.";
  if (!(Number(payload.lebar) > 0)) errors.lebar = "Lebar harus lebih dari 0.";
  if (!hasMaxDecimals(payload.lebar, 2)) errors.lebar = "Lebar maksimal 2 desimal.";
  if (!(Number(payload.panjang) > 0)) errors.panjang = "Panjang harus lebih dari 0.";
  if (!hasMaxDecimals(payload.panjang, 2)) errors.panjang = "Panjang maksimal 2 desimal.";
  if (!payload.hadap.length) errors.hadap = "Pilih minimal satu hadap.";
  if (!OPTIONS.tipe.includes(payload.tipe)) errors.tipe = "Tipe tidak valid.";
  if (!(Number(payload.tingkat) >= 1 && Number(payload.tingkat) <= 10)) errors.tingkat = "Tingkat harus antara 1 sampai 10.";
  if (!hasMaxDecimals(payload.tingkat, 1)) errors.tingkat = "Tingkat maksimal 1 desimal.";
  const price = parsePrice(payload.price);
  if (!(price > 0) || !Number.isInteger(price)) errors.price = "Harga harus integer rupiah lebih dari 0.";
  if (!OPTIONS.status.includes(payload.status)) errors.status = "Status tidak valid.";
  if (!OPTIONS.siap.includes(payload.siap)) errors.siap = "Kesiapan tidak valid.";
  if (!payload.kawasan.length) errors.kawasan = "Pilih minimal satu kawasan.";
  if (payload.maps_link && !isValidMapsUrl(payload.maps_link)) errors.maps_link = "Maps link harus URL valid dari google.com/maps.";
  return errors;
}

function validateContact(body) {
  const errors = {};
  if (!body.name) errors.name = "Nama wajib diisi.";
  if (!body.email) errors.email = "Email wajib diisi.";
  if (body.email && !isValidEmail(body.email)) errors.email = "Format email tidak valid.";
  if (!body.phone) errors.phone = "Nomor HP wajib diisi.";
  if (String(body.phone || "").replace(/\D/g, "").length < 10) errors.phone = "Nomor HP minimal 10 digit.";
  if (!body.message) errors.message = "Pesan wajib diisi.";
  return errors;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  let body = options.body;

  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;

  const response = await fetch(path, { method, headers, body, credentials: "same-origin" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request gagal.");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function radioOption(name, value, label) {
  return `<label><input type="radio" name="${name}" value="${escapeHtml(value)}"><span>${escapeHtml(label)}</span></label>`;
}

function textField(name, label, value, required = false, inputmode = "") {
  return `<div>
    <label data-field="${name}">${label} <span class="dirty-mark">Diubah</span><input name="${name}" value="${escapeHtml(value ?? "")}" ${required ? "required" : ""} ${inputmode ? `inputmode="${inputmode}"` : ""}></label>
    <p class="field-error" data-error-for="${name}"></p>
  </div>`;
}

function numberField(name, label, value, step) {
  return `<div>
    <label data-field="${name}">${label} <span class="dirty-mark">Diubah</span><input type="number" name="${name}" value="${escapeHtml(value ?? "")}" min="0" step="${step}" inputmode="decimal" required></label>
    <p class="field-error" data-error-for="${name}"></p>
  </div>`;
}

function selectField(name, label, options, value, labels = {}) {
  return `<div>
    <label data-field="${name}">${label} <span class="dirty-mark">Diubah</span>
      <select name="${name}" required>
        ${options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(labels[option] || option)}</option>`).join("")}
      </select>
    </label>
    <p class="field-error" data-error-for="${name}"></p>
  </div>`;
}

function checkboxGroup(name, label, options, selected = []) {
  return `<div class="wide">
    <label data-field="${name}">${label} <span class="dirty-mark">Diubah</span></label>
    <div class="check-grid">
      ${options
        .map(
          (option) =>
            `<label><input type="checkbox" name="${name}" value="${escapeHtml(option)}" ${selected.includes(option) ? "checked" : ""}>${escapeHtml(option)}</label>`
        )
        .join("")}
    </div>
    <p class="field-error" data-error-for="${name}"></p>
  </div>`;
}

function markDirtyFields(form, original) {
  const current = normalizePropertyForCompare(collectPropertyForm(form));
  form.querySelectorAll("[data-field]").forEach((label) => {
    const field = label.dataset.field;
    label.classList.toggle("dirty", JSON.stringify(current[field]) !== JSON.stringify(original[field]));
  });
}

function normalizePropertyForCompare(property) {
  return {
    nama_property: property.nama_property || "",
    group: property.group || "",
    lebar: String(property.lebar || ""),
    panjang: String(property.panjang || ""),
    hadap: [...(property.hadap || [])].sort(),
    tipe: property.tipe || "Ruko",
    tingkat: String(property.tingkat || ""),
    price: String(property.price || ""),
    carport: Boolean(property.carport),
    status: property.status || "in_stock",
    siap: property.siap || "siap_huni",
    kawasan: [...(property.kawasan || [])].sort(),
    unit: property.unit || "",
    maps_link: property.maps_link || ""
  };
}

function emptyProperty() {
  return {
    nama_property: "",
    group: "",
    lebar: "",
    panjang: "",
    hadap: [],
    tipe: "Ruko",
    tingkat: 1,
    price: "",
    carport: false,
    status: "in_stock",
    siap: "siap_huni",
    kawasan: [],
    unit: "",
    maps_link: ""
  };
}

function clearErrors(container) {
  container.querySelectorAll(".field-error").forEach((element) => {
    element.textContent = "";
  });
}

function showErrors(container, errors) {
  Object.entries(errors).forEach(([field, message]) => setFieldError(container, field, message));
}

function setFieldError(container, field, message) {
  const element = container.querySelector(`[data-error-for="${CSS.escape(field)}"]`);
  if (element) element.textContent = message;
}

function statusBadge(status, overrideLabel = "") {
  const label = overrideLabel || LABELS[status] || status;
  return `<span class="badge ${status === "sold_out" ? "sold" : "stock"}">${escapeHtml(label)}</span>`;
}

function siapBadge(siap) {
  const className = siap === "siap_huni" ? "gold" : siap === "siap_kosong" ? "purple" : "stock";
  return `<span class="badge ${className}">${escapeHtml(LABELS[siap] || siap)}</span>`;
}

function detailItem(label, value) {
  return `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function idToFilterKey(id) {
  return {
    filterKawasan: "kawasan",
    filterHadap: "hadap",
    filterSiap: "siap",
    filterLebarMin: "lebarMin",
    filterPriceMax: "priceMax"
  }[id];
}

function readControlValue(id) {
  const control = document.querySelector(`#${id}`);
  if (control.multiple) return [...control.selectedOptions].map((option) => option.value);
  return control.value;
}

function syncSelect(id, values) {
  const selected = new Set(values);
  document.querySelectorAll(`#${id} option`).forEach((option) => {
    option.selected = selected.has(option.value);
  });
}

function syncRadio(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${CSS.escape(value)}"]`);
  if (input) input.checked = true;
}

function parsePrice(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? Number(digits) : NaN;
}

function hasMaxDecimals(value, max) {
  const text = String(value ?? "").replace(",", ".");
  if (!text.includes(".")) return true;
  return text.split(".")[1].length <= max;
}

function isValidMapsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith("google.com") && url.pathname.startsWith("/maps");
  } catch {
    return false;
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatRupiah(value) {
  return `Rp ${Number(value || 0).toLocaleString("id-ID", { maximumFractionDigits: 0 }).replace(/,/g, ".")}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  }).format(new Date(value));
}

function toast(message, isError = false) {
  const root = document.querySelector("#toast-root");
  if (!root) return;
  const element = document.createElement("div");
  element.className = `toast${isError ? " error" : ""}`;
  element.textContent = message;
  root.appendChild(element);
  window.setTimeout(() => element.remove(), 4200);
}

function isSuperadmin() {
  return dashboardState?.user?.role === "superadmin";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
