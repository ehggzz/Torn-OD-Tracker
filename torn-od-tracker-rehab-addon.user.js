// ==UserScript==
// @name         Torn OD Tracker - Rehab Addon
// @namespace    https://github.com/ehggzz/Torn-OD-Tracker
// @version      0.1.0
// @description  Adds a rehab cost estimate panel to the existing Torn OD Tracker.
// @author       ehggzz
// @license      MIT
// @match        https://www.torn.com/profiles.php* 
// @run-at       document-end
// ==/UserScript==

(async () => {
  "use strict";

  const ADDON_ID = "od-tracker-rehab-addon";
  const KEY_NAME = "od_tracker_api_key";
  const PERSONALSTATS_URL = "https://api.torn.com/v2/user/personalstats?cat=all&comment=ODRehabAddon";
  const FACTION_UPGRADES_URL = "https://api.torn.com/v2/faction/upgrades?comment=ODRehabAddon";
  const REFRESH_MS = 30 * 60 * 1000;

  function getApiKey() {
    try {
      return String(localStorage.getItem(KEY_NAME) || "").trim();
    } catch {
      return "";
    }
  }

  async function requestJson(url, key) {
    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "Authorization": `ApiKey ${key}`
        }
      });
      return await response.json();
    } catch (error) {
      return { error: { error: error?.message || "Request failed" } };
    }
  }

  function getPersonalStats(response) {
    const stats = response?.personalstats;
    if (!stats) return null;
    const rehabs = Number(stats.rehabs);
    const rehabCost = Number(stats.rehabcost);
    if (!Number.isFinite(rehabs) && !Number.isFinite(rehabCost)) return null;
    return {
      rehabs: Number.isFinite(rehabs) ? Math.max(0, rehabs) : 0,
      rehabCost: Number.isFinite(rehabCost) ? Math.max(0, rehabCost) : 0
    };
  }

  function getFactionModifiers(response) {
    const branches = [
      ...(Array.isArray(response?.upgrades?.peace) ? response.upgrades.peace : []),
      ...(Array.isArray(response?.upgrades?.war) ? response.upgrades.war : [])
    ];

    let rehabReduction = 0;
    let addictionReduction = 0;

    for (const branch of branches) {
      for (const upgrade of (Array.isArray(branch?.upgrades) ? branch.upgrades : [])) {
        const name = String(upgrade?.name || "");
        const ability = String(upgrade?.ability || "");
        const text = `${name} ${ability}`;
        const level = Math.max(0, Number(upgrade?.level) || 0);

        if (/rehab/i.test(text) && /cost|fee/i.test(text)) {
          rehabReduction = Math.min(20, level * 2);
        }

        if (/addiction/i.test(text) && /reduce|reduction/i.test(text) && !/side effect|passive|negative/i.test(text)) {
          addictionReduction = Math.min(50, level * 2);
        }
      }
    }

    return { rehabReduction, addictionReduction };
  }

  function calculate(stats, modifiers) {
    if (!stats) return null;

    const rehabs = stats.rehabs;
    const baseCostPerAP = 2857 + (12.85 * rehabs);
    const apPerSession = Math.max(1, 250000 / baseCostPerAP);
    const sessionCost = 250000 * (1 - modifiers.rehabReduction / 100);
    const costPerAP = baseCostPerAP * (1 - modifiers.rehabReduction / 100);

    // Xanax normally adds 35 AP. Faction Toleration can reduce the AP gained.
    const xanaxAP = Math.max(1, Math.ceil(35 * (1 - modifiers.addictionReduction / 100)));
    const estimatedXanaxCost = xanaxAP * costPerAP;
    const averageHistoricalCost = rehabs > 0 ? stats.rehabCost / rehabs : null;

    return {
      rehabs,
      rehabCost: stats.rehabCost,
      rehabReduction: modifiers.rehabReduction,
      addictionReduction: modifiers.addictionReduction,
      sessionCost,
      baseCostPerAP,
      costPerAP,
      apPerSession,
      xanaxAP,
      estimatedXanaxCost,
      averageHistoricalCost
    };
  }

  function money(value) {
    return `$${Math.round(value).toLocaleString("en-GB")}`;
  }

  function injectStyles() {
    if (document.getElementById("odt-rehab-addon-style")) return;
    const style = document.createElement("style");
    style.id = "odt-rehab-addon-style";
    style.textContent = `
      #${ADDON_ID} { margin-top:10px; border-top:1px solid #333; padding-top:9px; }
      #${ADDON_ID} .rehab-header { width:100%; border:0; background:none; color:#ddd; text-align:left; padding:3px 0; font-size:12px; font-weight:600; cursor:pointer; }
      #${ADDON_ID} .rehab-arrow { float:right; opacity:.7; }
      #${ADDON_ID} .rehab-body { display:none; margin-top:7px; }
      #${ADDON_ID} .rehab-body.open { display:block; }
      #${ADDON_ID} .rehab-grid { display:grid; grid-template-columns:1fr auto; gap:4px 8px; font-size:12px; line-height:1.45; }
      #${ADDON_ID} .rehab-value { text-align:right; color:#fff; font-weight:600; }
      #${ADDON_ID} .rehab-note { margin-top:8px; font-size:10px; opacity:.65; line-height:1.4; }
      #${ADDON_ID} .rehab-error { font-size:11px; opacity:.7; }
    `;
    document.head.appendChild(style);
  }

  function buildPanel() {
    if (document.getElementById(ADDON_ID)) return document.getElementById(ADDON_ID);
    const panel = document.querySelector("#od-tracker-root .odt-panel");
    if (!panel) return null;

    const root = document.createElement("div");
    root.id = ADDON_ID;
    root.innerHTML = `
      <button class="rehab-header" type="button">🏥 Rehab Estimate <span class="rehab-arrow">▾</span></button>
      <div class="rehab-body">
        <div class="rehab-grid">
          <span>Lifetime rehabs</span><span class="rehab-value rehab-count">Checking…</span>
          <span>Current cost per rehab</span><span class="rehab-value rehab-session-cost">Checking…</span>
          <span>Lifetime rehab spend</span><span class="rehab-value rehab-spend">Checking…</span>
          <span>Estimated AP removed per rehab</span><span class="rehab-value rehab-ap">Checking…</span>
          <span>Estimated cost per AP</span><span class="rehab-value rehab-ap-cost">Checking…</span>
          <span>Estimated rehab cost per Xanax</span><span class="rehab-value rehab-xanax">Checking…</span>
          <span>Faction rehab reduction</span><span class="rehab-value rehab-reduction">Checking…</span>
          <span>Faction addiction reduction</span><span class="rehab-value rehab-addiction-reduction">Checking…</span>
        </div>
        <div class="rehab-note">Checking rehab data…</div>
      </div>`;

    const testButton = panel.querySelector(".odt-api-test");
    if (testButton) panel.insertBefore(root, testButton);
    else panel.appendChild(root);

    const header = root.querySelector(".rehab-header");
    const body = root.querySelector(".rehab-body");
    header.addEventListener("click", () => {
      const open = body.classList.toggle("open");
      root.querySelector(".rehab-arrow").textContent = open ? "▴" : "▾";
    });

    return root;
  }

  function render(root, estimate, error) {
    if (!root) return;
    const set = (name, value) => {
      const el = root.querySelector("." + name);
      if (el) el.textContent = value;
    };

    if (error) {
      set("rehab-count", "Unavailable");
      set("rehab-session-cost", "Unavailable");
      set("rehab-spend", "Unavailable");
      set("rehab-ap", "Unavailable");
      set("rehab-ap-cost", "Unavailable");
      set("rehab-xanax", "Unavailable");
      set("rehab-reduction", "Unavailable");
      set("rehab-addiction-reduction", "Unavailable");
      const note = root.querySelector(".rehab-note");
      if (note) note.textContent = error;
      return;
    }

    set("rehab-count", estimate.rehabs.toLocaleString("en-GB"));
    set("rehab-session-cost", money(estimate.sessionCost));
    set("rehab-spend", money(estimate.rehabCost));
    set("rehab-ap", estimate.apPerSession.toFixed(1) + " AP");
    set("rehab-ap-cost", money(estimate.costPerAP) + "/AP");
    set("rehab-xanax", money(estimate.estimatedXanaxCost));
    set("rehab-reduction", estimate.rehabReduction + "%");
    set("rehab-addiction-reduction", estimate.addictionReduction + "%");

    const note = root.querySelector(".rehab-note");
    if (note) note.textContent = "Estimate only. Torn's API does not expose your current hidden addiction points, so this cannot tell you exactly how many rehab sessions you need right now. It uses your lifetime rehab count, current faction reductions and the community-validated rehab cost formula.";
  }

  async function refresh(root) {
    const key = getApiKey();
    if (!key) {
      render(root, null, "Save your Torn API key in OD Tracker first.");
      return;
    }

    const [statsResponse, factionResponse] = await Promise.all([
      requestJson(PERSONALSTATS_URL, key),
      requestJson(FACTION_UPGRADES_URL, key)
    ]);

    if (statsResponse?.error) {
      render(root, null, `Personal stats unavailable: ${statsResponse.error.error || "API error"}`);
      return;
    }

    const stats = getPersonalStats(statsResponse);
    if (!stats) {
      render(root, null, "Rehab statistics were not returned by the current API key.");
      return;
    }

    const modifiers = getFactionModifiers(factionResponse);
    render(root, calculate(stats, modifiers), null);
  }

  async function init() {
    injectStyles();

    let root = null;
    for (let i = 0; i < 30; i++) {
      root = buildPanel();
      if (root) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!root) return;

    await refresh(root);
    setInterval(() => refresh(root), REFRESH_MS);
  }

  init();
})();
