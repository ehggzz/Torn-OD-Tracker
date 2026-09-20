// ==UserScript==
// @name         Torn OD Tracker
// @namespace    https://github.com/ehggzz/Torn-OD-Tracker
// @version      0.5.0
// @description  Track time since your last overdose and Xanax taken since then.
// @author       ehggzz
// @match        https://www.torn.com/*
// @run-at       document-end
// ==/UserScript==

(async () => {
  "use strict";

  const STORAGE_KEY = "od_tracker_data_v1";
  const ROOT_ID = "od-tracker-root";
  const PDA_API_KEY = "###PDA-APIKEY###";
  const EVENTS_API_URL = `https://api.torn.com/user/?selections=events&key=${encodeURIComponent(PDA_API_KEY)}&comment=TornODTracker`;
  // Torn's user/log selection is still served through the v1-style endpoint.
  // /v2/user/log is not a migrated v2 route.
  const OD_LOG_API_BASE = `https://api.torn.com/v2/user/log?log=2291&limit=100&key=${encodeURIComponent(PDA_API_KEY)}&comment=TornODTracker`;
  const XANAX_LOG_API_BASE = `https://api.torn.com/v2/user/log?log=2290,2291&limit=100&key=${encodeURIComponent(PDA_API_KEY)}&comment=TornODTracker`;
  const POLL_MS = 5 * 60 * 1000;

  const defaultData = {
    lastOD: null,
    trackingStarted: null,
    history: [],
    xanaxSinceOD: 0,
    eventCheckpoint: null,
    xanaxBaseline: null,
    xanaxBaselineForOD: null
  };

  async function loadData() {
    try {
      if (typeof PDA_storage !== "undefined") {
        return { ...defaultData, ...(await PDA_storage.get(STORAGE_KEY, defaultData)) };
      }
    } catch (e) {
      console.warn("[OD Tracker] PDA storage unavailable:", e);
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...defaultData, ...JSON.parse(raw) } : { ...defaultData };
    } catch {
      return { ...defaultData };
    }
  }

  async function saveData(data) {
    try {
      if (typeof PDA_storage !== "undefined") {
        await PDA_storage.set(STORAGE_KEY, data);
        return;
      }
    } catch (e) {
      console.warn("[OD Tracker] PDA storage write failed:", e);
    }
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
    return d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function parseUserDateTime(value) {
    const text = String(value || "").trim();
    const uk = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);

    if (uk) {
      const day = Number(uk[1]);
      const month = Number(uk[2]);
      const year = Number(uk[3]);
      const hour = uk[4] === undefined ? 0 : Number(uk[4]);
      const minute = uk[5] === undefined ? 0 : Number(uk[5]);

      if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;

      const d = new Date(year, month - 1, day, hour, minute, 0, 0);
      if (
        d.getFullYear() !== year ||
        d.getMonth() !== month - 1 ||
        d.getDate() !== day ||
        d.getHours() !== hour ||
        d.getMinutes() !== minute
      ) return null;

      return d;
    }

    const iso = new Date(text);
    return Number.isNaN(iso.getTime()) ? null : iso;
  }

  function normaliseHistory(data) {
    if (!Array.isArray(data.history)) data.history = [];

    data.history = data.history.map(entry => {
      if (typeof entry === "string") return { od: entry, xanax: null };
      return {
        od: entry?.od || entry?.lastOD || null,
        xanax: Number.isFinite(Number(entry?.xanax)) ? Number(entry.xanax) : null
      };
    }).filter(entry => entry.od);
  }

  function addHistoryEntry(data, odIso, xanaxCount) {
    normaliseHistory(data);
    const existing = data.history.find(x => x.od === odIso);
    if (existing) {
      if (xanaxCount !== null && xanaxCount !== undefined) existing.xanax = xanaxCount;
    } else {
      data.history.unshift({ od: odIso, xanax: xanaxCount });
    }
    data.history = data.history.slice(0, 50);
  }

  function isXanaxUse(eventText) {
    return typeof eventText === "string" &&
      /\b(?:popped?|took)\b.*\bxanax\b/i.test(eventText);
  }

  function isXanaxOD(eventText) {
    return typeof eventText === "string" &&
      /overdos/i.test(eventText) &&
      /xanax/i.test(eventText);
  }

  function getEventList(events) {
    if (!events) return [];
    const list = Array.isArray(events) ? events : Object.values(events);
    return list
      .map(e => ({
        timestamp: Number(e?.timestamp) * 1000,
        text: typeof e?.event === "string" ? e.event : ""
      }))
      .filter(e => Number.isFinite(e.timestamp) && e.timestamp > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async function requestJson(url) {
    try {
      if (typeof PDA_httpGet === "function") {
        const result = await PDA_httpGet(url, {});
        const text = result?.responseText ?? result;
        return typeof text === "string" ? JSON.parse(text) : text;
      }

      return await (await fetch(url)).json();
    } catch (e) {
      console.warn("[OD Tracker] API request failed:", e);
      return null;
    }
  }

  function withKey(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.searchParams.get("key")) {
        parsed.searchParams.set("key", PDA_API_KEY);
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  async function fetchODLogs() {
    if (!PDA_API_KEY || PDA_API_KEY === "###PDA-APIKEY###") return null;
    const response = await requestJson(OD_LOG_API_BASE);

    if (response?.error) {
      console.warn("[OD Tracker] OD log request returned an API error:", response.error);
      return null;
    }

    return response;
  }

  function getLogList(response) {
    if (!response?.log || !Array.isArray(response.log)) return [];

    return response.log
      .map(entry => ({
        userLogId: String(entry?.id || ""),
        timestamp: Number(entry?.timestamp) * 1000,
        id: Number(entry?.details?.id),
        title: String(entry?.details?.title || "")
      }))
      .filter(entry =>
        Number.isFinite(entry.timestamp) &&
        entry.timestamp > 0 &&
        Number.isFinite(entry.id)
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async function scanODLogs(data) {
    const response = await fetchODLogs();
    if (!response || response.error) return null;

    const logs = getLogList(response);
    if (!logs.length) return false;

    const baseTime = data.lastOD
      ? new Date(data.lastOD).getTime()
      : new Date(data.trackingStarted || Date.now()).getTime();

    let changed = false;

    for (const log of logs) {
      if (log.timestamp <= baseTime || log.id !== 2291) continue;

      const odIso = new Date(log.timestamp).toISOString();

      if (data.lastOD !== odIso) {
        if (data.lastOD) {
          addHistoryEntry(data, data.lastOD, Number(data.xanaxSinceOD) || 0);
        }

        data.lastOD = odIso;
        data.xanaxSinceOD = 0;
        data.xanaxBaseline = null;
        data.xanaxBaselineForOD = null;
        data.eventCheckpoint = log.timestamp;
        changed = true;
      }
    }

    if (changed) await saveData(data);
    return changed;
  }

  async function countXanaxLogsSinceOD(data) {
    if (!data.lastOD) return null;

    const odTime = new Date(data.lastOD).getTime();
    if (!Number.isFinite(odTime)) return null;
    if (!PDA_API_KEY || PDA_API_KEY === "###PDA-APIKEY###") return null;

    let url = `${XANAX_LOG_API_BASE}&from=${Math.floor(odTime / 1000)}`;
    let total = 0;
    let pages = 0;
    const seenPages = new Set();

    while (url && pages < 20 && !seenPages.has(url)) {
      seenPages.add(url);
      pages++;

      const response = await requestJson(url);
      if (!response || response.error) {
        if (response?.error) {
          console.warn("[OD Tracker] Xanax log request returned an API error:", response.error);
        }
        return null;
      }

      for (const log of getLogList(response)) {
        // The overdose-causing dose is at the OD timestamp itself.
        // Only count Xanax uses strictly after the recorded OD.
        if (log.timestamp > odTime && (log.id === 2290 || log.id === 2291)) {
          total++;
        }
      }

      const next = response?._metadata?.links?.next;
      url = next ? withKey(next) : null;
    }

    return total;
  }

  async function syncXanaxCount(data) {
    const count = await countXanaxLogsSinceOD(data);
    if (count === null) return false;

    if (Number(data.xanaxSinceOD) !== count) {
      data.xanaxSinceOD = count;
      await saveData(data);
      return true;
    }

    return false;
  }

  async function fetchEvents() {
    if (!PDA_API_KEY || PDA_API_KEY === "###PDA-APIKEY###") return null;

    try {
      if (typeof PDA_httpGet === "function") {
        const response = await PDA_httpGet(EVENTS_API_URL, {});
        const text = response?.responseText ?? response;
        return typeof text === "string" ? JSON.parse(text) : text;
      }

      const response = await fetch(EVENTS_API_URL);
      return await response.json();
    } catch (e) {
      console.warn("[OD Tracker] Event request failed:", e);
      return null;
    }
  }

  async function scanEvents(data) {
    const response = await fetchEvents();
    if (!response || response.error || !response.events) return false;

    const events = getEventList(response.events);
    if (!events.length) return false;

    normaliseHistory(data);

    const baseTime = data.lastOD
      ? new Date(data.lastOD).getTime()
      : new Date(data.trackingStarted || Date.now()).getTime();

    if (!data.eventCheckpoint) data.eventCheckpoint = baseTime;

    let checkpoint = Number(data.eventCheckpoint) || baseTime;
    let changed = false;

    for (const event of events) {
      if (event.timestamp <= checkpoint) continue;

      // We only use the event stream to identify the exact time of an OD.
      // Xanax totals themselves come from personalstats.xantaken.
      if (isXanaxOD(event.text)) {
        const odIso = new Date(event.timestamp).toISOString();

        if (data.lastOD !== odIso) {
          if (data.lastOD) {
            addHistoryEntry(data, data.lastOD, Number(data.xanaxSinceOD) || 0);
          }

          data.lastOD = odIso;
          data.xanaxSinceOD = 0;
          data.xanaxBaseline = null;
          data.xanaxBaselineForOD = null;
          changed = true;
        }
      }

      checkpoint = Math.max(checkpoint, event.timestamp);
    }

    if (checkpoint !== data.eventCheckpoint) {
      data.eventCheckpoint = checkpoint;
      changed = true;
    }

    if (changed) await saveData(data);

    // Refresh the cumulative Xanax calculation after processing any new OD.
    const xanaxChanged = await syncXanaxCount(data);
    return changed || xanaxChanged;
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
      #${ROOT_ID} .odt-stat { margin-top:4px; font-size:13px; color:#ddd; }
      #${ROOT_ID} .odt-muted { opacity:.65; font-size:11px; }
      #${ROOT_ID} .odt-buttons { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-top:10px; }
      #${ROOT_ID} button.odt-action {
        border:1px solid #444; border-radius:3px; padding:7px 5px;
        background:#2a2a2a; color:#ddd; cursor:pointer; font-size:11px;
      }
      #${ROOT_ID} button.odt-action:hover { background:#383838; }
      #${ROOT_ID} .odt-history { margin-top:10px; display:none; }
      #${ROOT_ID} .odt-history.open { display:block; }
      #${ROOT_ID} .odt-history-row { padding:5px 0; border-bottom:1px solid #333; }
      #${ROOT_ID} .odt-history-xan { opacity:.7; margin-left:5px; }
      #${ROOT_ID} .odt-danger { color:#f08a8a !important; }
      #${ROOT_ID} .odt-api-note { margin-top:8px; font-size:10px; opacity:.55; }
    `;
    document.head.appendChild(style);
  }

  function findProfileInsertionPoint() {
    return document.querySelector("#profileroot") ||
      document.querySelector(".profile-container") ||
      document.querySelector("#mainContainer .content-wrapper") ||
      document.querySelector("#mainContainer") ||
      document.body;
  }

  async function setLastOD(iso, data, preserveCount = false) {
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) return;

    if (data.lastOD && !preserveCount) {
      addHistoryEntry(data, data.lastOD, Number(data.xanaxSinceOD) || 0);
    }

    data.lastOD = value.toISOString();
    data.xanaxSinceOD = preserveCount ? (Number(data.xanaxSinceOD) || 0) : 0;
    data.xanaxBaseline = null;
    data.xanaxBaselineForOD = null;
    data.eventCheckpoint = value.getTime();
    data.trackingStarted = data.trackingStarted || new Date().toISOString();

    await saveData(data);
    await syncXanaxCount(data);
    await render(data);
  }

  async function render(data) {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    normaliseHistory(data);

    const panel = root.querySelector(".odt-panel");
    root.querySelector(".odt-arrow").textContent =
      panel.classList.contains("open") ? "▴" : "▾";

    if (data.lastOD) {
      root.querySelector(".odt-time").textContent =
        formatDuration(Date.now() - new Date(data.lastOD).getTime());
      root.querySelector(".odt-status").textContent = "since last overdose";
      root.querySelector(".odt-last").textContent =
        `Last OD: ${formatDate(data.lastOD)}`;
      root.querySelector(".odt-xanax").textContent =
        `💊 Xanax since OD: ${Number(data.xanaxSinceOD) || 0}`;
    } else {
      root.querySelector(".odt-time").textContent = "Previous OD unknown";
      root.querySelector(".odt-status").textContent =
        data.trackingStarted
          ? `Tracking since ${formatDate(data.trackingStarted)}`
          : "Tracking has not started";
      root.querySelector(".odt-last").textContent = "";
      root.querySelector(".odt-xanax").textContent =
        `💊 Xanax since tracking started: ${Number(data.xanaxSinceOD) || 0}`;
    }

    const h = root.querySelector(".odt-history");
    if (h.classList.contains("open")) {
      h.innerHTML = data.history.length
        ? data.history.map((entry, i) => {
            const xanax = entry.xanax === null || entry.xanax === undefined
              ? ""
              : `<span class="odt-history-xan">• ${entry.xanax} Xanax</span>`;
            return `<div class="odt-history-row">${i + 1}. ${formatDate(entry.od)} ${xanax}</div>`;
          }).join("")
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
          <div class="odt-stat odt-xanax">💊 Xanax since OD: 0</div>
        </div>
        <div class="odt-buttons">
          <button class="odt-action" data-action="record">💀 Record OD</button>
          <button class="odt-action" data-action="edit">✏️ Edit</button>
          <button class="odt-action" data-action="history">📜 History</button>
          <button class="odt-action odt-danger" data-action="reset">🗑️ Reset</button>
        </div>
        <div class="odt-history"></div>
        <div class="odt-api-note">Xanax total uses Torn personalstats; OD detection checks your event log periodically.</div>
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
        if (confirm("Record an overdose now?")) {
          await setLastOD(new Date().toISOString(), data);
        }
      } else if (action === "edit") {
        const value = prompt(
          "Enter your last overdose date/time in UK format (DD/MM/YYYY HH:MM). Time is optional.\n\nExample: 05/09/2026 21:30",
          data.lastOD ? formatDate(data.lastOD) : ""
        );

        if (value) {
          const parsed = parseUserDateTime(value);

          if (!parsed) {
            alert("I couldn't read that date. Please use DD/MM/YYYY HH:MM\n\nExample: 05/09/2026 21:30");
            return;
          }

          await setLastOD(parsed.toISOString(), data);
        }
      } else if (action === "history") {
        root.querySelector(".odt-history").classList.toggle("open");
        await render(data);
      } else if (action === "reset") {
        if (confirm("Reset OD Tracker and erase its recorded OD history?")) {
          data.lastOD = null;
          data.trackingStarted = new Date().toISOString();
          data.xanaxSinceOD = 0;
          data.xanaxBaseline = null;
          data.xanaxBaselineForOD = null;
          data.eventCheckpoint = data.trackingStarted ? new Date(data.trackingStarted).getTime() : Date.now();
          data.history = [];
          await saveData(data);
          await render(data);
        }
      }
    });

    await render(data);
    setInterval(() => render(data), 30000);
  }

  async function init() {
    const data = await loadData();

    if (!data.trackingStarted) {
      data.trackingStarted = new Date().toISOString();
      await saveData(data);
    }

    // Use Torn's dedicated Xanax-overdose log as the primary OD source.
    // If the key cannot access user/log, fall back to the older events feed.
    const logResult = await scanODLogs(data);
    if (logResult === null) {
      await scanEvents(data);
    }
    await syncXanaxCount(data);

    setInterval(async () => {
      const latestLogResult = await scanODLogs(data);
      if (latestLogResult === null) {
        await scanEvents(data);
      }
      await syncXanaxCount(data);
      await render(data);
    }, POLL_MS);

    // Only show the visual widget on profile pages.
    if (!/\/profiles\.php/i.test(location.pathname)) return;

    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      if (findProfileInsertionPoint()) {
        clearInterval(timer);
        await build(data);
      }
      if (attempts >= 20) clearInterval(timer);
    }, 500);
  }

  init();
})();