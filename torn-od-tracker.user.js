// ==UserScript==
// @name         Torn OD Tracker
// @namespace    https://github.com/ehggzz/Torn-OD-Tracker
// @version      0.1.0
// @description  A simple, local Torn PDA tracker for time since your last overdose.
// @author       ehggzz
// @match        https://www.torn.com/profiles.php?*
// @run-at       document-end
// ==/UserScript==

(async () => {
  "use strict";
  const STORAGE_KEY = "od_tracker_data_v1";
  const ROOT_ID = "od-tracker-root";
  const defaultData = { lastOD: null, trackingStarted: null, history: [] };

  async function loadData() {
    try {
      if (typeof PDA_storage !== "undefined") {
        return { ...defaultData, ...(await PDA_storage.get(STORAGE_KEY, defaultData)) };
      }
    } catch (e) { console.warn("[OD Tracker] PDA storage unavailable:", e); }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...defaultData, ...JSON.parse(raw) } : { ...defaultData };
    } catch { return { ...defaultData }; }
  }

  async function saveData(data) {
    try {
      if (typeof PDA_storage !== "undefined") {
        await PDA_storage.set(STORAGE_KEY, data);
        return;
      }
    } catch (e) { console.warn("[OD Tracker] PDA storage write failed:", e); }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "0m";
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function formatDate(value) {
    if (!value) return "Unknown";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "Unknown";
    return d.toLocaleString(undefined, {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  }

  function injectStyles() {
    if (document.getElementById("od-tracker-style")) return;
    const style = document.createElement("style");
    style.id = "od-tracker-style";
    style.textContent = `
      #${ROOT_ID} { margin: 8px 0; font-family: Arial, Helvetica, sans-serif; }
      #${ROOT_ID} .odt-header {
        width:100%; box-sizing:border-box; border:0; border-radius:4px;
        padding:9px 11px; background:rgba(30,30,30,.92); color:#ddd;
        text-align:left; font-size:13px; font-weight:600; cursor:pointer;
      }
      #${ROOT_ID} .odt-header:hover { background:rgba(45,45,45,.96); }
      #${ROOT_ID} .odt-arrow { float:right; opacity:.7; }
      #${ROOT_ID} .odt-panel {
        display:none; margin-top:2px; padding:12px; border-radius:0 0 4px 4px;
        background:rgba(24,24,24,.96); color:#ccc; font-size:12px; line-height:1.45;
      }
      #${ROOT_ID} .odt-panel.open { display:block; }
      #${ROOT_ID} .odt-main { text-align:center; margin-bottom:10px; }
      #${ROOT_ID} .odt-time { font-size:19px; font-weight:700; color:#fff; }
      #${ROOT_ID} .odt-muted { opacity:.65; font-size:11px; }
      #${ROOT_ID} .odt-buttons { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:10px; }
      #${ROOT_ID} button.odt-action {
        border:1px solid #444; border-radius:3px; padding:7px 5px;
        background:#2a2a2a; color:#ddd; cursor:pointer; font-size:11px;
      }
      #${ROOT_ID} button.odt-action:hover { background:#383838; }
      #${ROOT_ID} .odt-history { margin-top:10px; display:none; }
      #${ROOT_ID} .odt-history.open { display:block; }
      #${ROOT_ID} .odt-history-row { padding:4px 0; border-bottom:1px solid #333; }
      #${ROOT_ID} .odt-danger { color:#f08a8a !important; }
    `;
    document.head.appendChild(style);
  }

  function findProfileInsertionPoint() {
    return document.querySelector("#profileroot") ||
      document.querySelector(".profile-container") ||
      document.querySelector("#mainContainer .content-wrapper") ||
      document.querySelector("#mainContainer") || document.body;
  }

  async function setLastOD(iso, data) {
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return;
    data.lastOD = value.toISOString();
    data.trackingStarted = data.trackingStarted || new Date().toISOString();
    data.history = Array.isArray(data.history) ? data.history : [];
    if (!data.history.includes(data.lastOD)) {
      data.history.unshift(data.lastOD);
      data.history = data.history.slice(0, 50);
    }
    await saveData(data);
    await render(data);
  }

  async function render(data) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const panel = root.querySelector(".odt-panel");
    root.querySelector(".odt-arrow").textContent = panel.classList.contains("open") ? "▴" : "▾";
    if (data.lastOD) {
      root.querySelector(".odt-time").textContent = formatDuration(Date.now() - new Date(data.lastOD).getTime());
      root.querySelector(".odt-status").textContent = "since last overdose";
      root.querySelector(".odt-last").textContent = `Last OD: ${formatDate(data.lastOD)}`;
    } else {
      root.querySelector(".odt-time").textContent = "Previous OD unknown";
      root.querySelector(".odt-status").textContent =
        data.trackingStarted ? `Tracking since ${formatDate(data.trackingStarted)}` : "Tracking has not started";
      root.querySelector(".odt-last").textContent = "";
    }
    const h = root.querySelector(".odt-history");
    if (h.classList.contains("open")) {
      h.innerHTML = data.history.length
        ? data.history.map((x,i)=>`<div class="odt-history-row">${i+1}. ${formatDate(x)}</div>`).join("")
        : '<div class="odt-muted">No OD history recorded yet.</div>';
    }
  }

  async function build(data) {
    if (document.getElementById(ROOT_ID)) return;
    injectStyles();
    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button class="odt-header" type="button" aria-expanded="false">
        💊 OD Tracker <span class="odt-arrow">▾</span>
      </button>
      <div class="odt-panel">
        <div class="odt-main">
          <div class="odt-time">Loading…</div>
          <div class="odt-status">Loading…</div>
          <div class="odt-last"></div>
        </div>
        <div class="odt-buttons">
          <button class="odt-action" data-action="record">💀 Record OD</button>
          <button class="odt-action" data-action="edit">✏️ Edit</button>
          <button class="odt-action" data-action="history">📜 History</button>
          <button class="odt-action odt-danger" data-action="reset">🗑️ Reset</button>
        </div>
        <div class="odt-history"></div>
      </div>`;
    findProfileInsertionPoint().prepend(root);
    const header = root.querySelector(".odt-header");
    const panel = root.querySelector(".odt-panel");
    header.addEventListener("click", () => {
      const open = panel.classList.toggle("open");
      header.setAttribute("aria-expanded", String(open));
      header.querySelector(".odt-arrow").textContent = open ? "▴" : "▾";
    });
    root.addEventListener("click", async event => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "record") {
        if (confirm("Record an overdose now?")) await setLastOD(new Date().toISOString(), data);
      } else if (action === "edit") {
        const value = prompt("Enter your last overdose date/time (YYYY-MM-DDTHH:MM):", data.lastOD ? new Date(data.lastOD).toISOString().slice(0,16) : "");
        if (value) await setLastOD(value, data);
      } else if (action === "history") {
        root.querySelector(".odt-history").classList.toggle("open");
        await render(data);
      } else if (action === "reset") {
        if (confirm("Reset OD Tracker and erase its recorded OD history?")) {
          data.lastOD = null; data.trackingStarted = new Date().toISOString(); data.history = [];
          await saveData(data); await render(data);
        }
      }
    });
    await render(data);
    setInterval(() => render(data), 30000);
  }

  async function init() {
    if (!/\/profiles\.php/i.test(location.pathname)) return;
    const data = await loadData();
    if (!data.trackingStarted) { data.trackingStarted = new Date().toISOString(); await saveData(data); }
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      if (findProfileInsertionPoint()) { clearInterval(timer); await build(data); }
      if (attempts >= 20) clearInterval(timer);
    }, 500);
  }
  init();
})();