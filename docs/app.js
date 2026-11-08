/* Mirror Terrain web explorer. All numbers come from data/*.json written by the notebook (section 8b). */
(function () {
  "use strict";
  const LANGS = ["tr", "en", "fr", "ru", "de"];
  const D = {};                       // loaded data
  const S = {                         // UI state
    lang: "en", target: "Moon_Shackleton", mode: "genel", marsDs: "mars200",
    layers: { known: true, turkey: true, scan: true, control: false }, view: "explore"
  };
  const VERSION_DATE = "2026-11-15";   // sürüm tarihi: sitenin bu sürümü
  let map, trmap, winLayer, extraLayer, charts = [];

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function t(key, vars) {
    const dict = window.I18N[S.lang] || {}, en = window.I18N.en;
    let s = dict[key] ?? en[key] ?? key;
    if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  }
  const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v)) ? "–" :
    Number(v).toLocaleString(S.lang === "en" ? "en-US" : S.lang, { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v, d = 0) => (v === null || v === undefined) ? "–" : fmt(v * 100, d) + "%";
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const gmaps = (lat, lon) => `https://www.google.com/maps/@${lat},${lon},12000m/data=!3m1!1e3`;
  function store(k, v) { try { localStorage.setItem("mt_" + k, v); } catch (e) { /* storage unavailable */ } }
  function load(k) { try { return localStorage.getItem("mt_" + k); } catch (e) { return null; } }

  const TARGET_ORDER = ["Moon_Shackleton", "Moon_deGerlache", "Moon_Malapert", "Mars_Gusev_Spirit", "Mars_Jezero", "Mars_Gale_Curiosity", "Mars_Meridiani_Oppy"];
  const FEATS = [
    ["relief_m", (v) => fmt(v, 0) + " m"], ["slope_mean", (v) => fmt(v, 1) + "°"], ["slope_p90", (v) => fmt(v, 1) + "°"],
    ["steep_frac", (v) => pct(v)], ["roughness_m", (v) => fmt(v, 1) + " m"], ["hypsometry", (v) => fmt(v, 2)], ["w_barren_frac", (v) => pct(v)]
  ];
  const NAMED_SCAN = {
    "SCAN_39.75N_39.75E": "place.kesis", "SCAN_37.25N_34.35E": "place.toros", "SCAN_38.55N_33.65E": "place.tuz_east",
    "SCAN_38.55N_33.15E": "place.tuz_west", "SCAN_38.15N_42.95E": "place.van_south"
  };
  const GROUP_STYLE = {
    known: { color: "#f6e3cf", weight: 2.2 }, turkey: { color: "#1b1b1b", weight: 2 }, scan: { color: "#1b1b1b", weight: 0.8 }, control: { color: "#7d7d7d", weight: 1 }
  };
  // perceptual ramp: low = deep violet, high = cream (reads on satellite and plain backgrounds)
  const RAMP = ["#2d1442", "#5b1f5e", "#933058", "#c9533c", "#ec8c3f", "#f8d48c"];
  function rampColor(x) {
    x = Math.max(0, Math.min(1, x)); const p = x * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(p)), f = p - i;
    const a = RAMP[i], b = RAMP[i + 1], h = (s, o) => parseInt(s.slice(o, o + 2), 16);
    const c = [1, 3, 5].map((o) => Math.round(h(a, o) + (h(b, o) - h(a, o)) * f));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  function siteName(site, lat, lon, ap) {
    if (NAMED_SCAN[site]) return t(NAMED_SCAN[site]);
    if (window.I18N.en["site." + site]) return t("site." + site);
    if (site.startsWith("SCAN_")) {
      if (!lat && !lon) { const m = site.match(/SCAN_([\d.]+)N_([\d.]+)E/); if (m) { lat = +m[1]; lon = +m[2]; } }
      const c = `${fmt(lat, 2)}°N ${fmt(lon, 2)}°E`;
      return ap ? t("scan.near", { c, ap }) : t("scan.cell", { c });
    }
    return site;
  }
  const targetName = (id) => t("target." + id);
  const bodyOf = (id) => id.startsWith("Moon") ? "moon" : "mars";
  const dsOf = (id) => bodyOf(id) === "moon" ? "moon40" : S.marsDs;
  const meta = (id) => D.meta.targets.find((x) => x.id === id);

  // ---------- data ----------
  async function getJSON(name, optional) {
    try {
      const r = await fetch("data/" + name + ".json"); if (!r.ok) throw new Error(r.status);
      return JSON.parse((await r.text()).replace(/\bNaN\b/g, "null"));     // Python may write NaN for missing values
    }
    catch (e) { if (optional) return null; throw e; }
  }
  async function loadAll() {
    const names = ["meta", "windows_moon40", "windows_mars200", "windows_mars463", "twins", "turkey", "scan_grid", "climate",
      "validation", "rock", "extra", "access", "cards"];
    const opt = ["emit", "countries", "robust_sites", "artemis", "cells"];
    const res = await Promise.all(names.map((n) => getJSON(n)).concat(opt.map((n) => getJSON(n, true))));
    names.concat(opt).forEach((n, i) => (D[n] = res[i]));
  }

  // site-level robustness: share of the 200 weight draws in which a site is Türkiye's best / in the overall top 3
  function robSite(ds, target, site) {
    if (!D.robust_sites) return null;
    return D.robust_sites.rows.find((r) => r.veri === ds && r.target === target && r.site === site) || null;
  }

  // window table for a dataset with current scores
  function view(id = S.target, mode = S.mode) {
    const W = D["windows_" + dsOf(id)];
    const sc = (W.scores[id] || {})[mode] || [];
    return { W, sc };
  }
  function bestIdx(W, sc, groups) {
    let b = -1;
    for (let i = 0; i < sc.length; i++) if (groups.includes(W.group[i]) && sc[i] !== null && (b < 0 || sc[i] > sc[b])) b = i;
    return b;
  }

  // ---------- i18n on static nodes ----------
  function applyStatic() {
    document.documentElement.lang = S.lang;
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    $("#lang").innerHTML = LANGS.map((l) => `<button type="button" data-l="${l}" aria-pressed="${l === S.lang}" title="${t("lang." + l)}">${l}</button>`).join("");
    const ver = new Intl.DateTimeFormat(S.lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date(VERSION_DATE + "T12:00:00"));
    $("#foot").innerHTML = `<div style="max-width:1600px;margin:0 auto">${t("foot")}<br>${t("foot.ver", { d: ver })}</div>`;
  }

  // ---------- routing ----------
  const VIEWS = ["explore", "findings", "turkey", "plan", "field", "rover", "validation", "method", "files", "about"];
  function route() {
    const h = (location.hash || "#explore").slice(1);
    S.view = VIEWS.includes(h) ? h : "explore";
    VIEWS.forEach((v) => ($("#v-" + v).hidden = v !== S.view));
    document.querySelectorAll("nav.tabs a").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === "#" + S.view ? "page" : "false"));
    renderView();
  }
  function renderView() {
    charts.forEach((c) => c.destroy()); charts = [];
    if (S.view !== "rover" && typeof rvStop === "function") rvStop();
    if (S.view === "explore") { renderIntro(); renderControls(); renderMap(); renderDetail(); setTimeout(() => map && map.invalidateSize(), 50); }
    if (S.view === "findings") renderFindings();
    if (S.view === "turkey") renderTurkey();
    if (S.view === "rover") renderRover();
    if (S.view === "plan") renderPlan();
    if (S.view === "field") renderField();
    if (S.view === "validation") renderValidation();
    if (S.view === "method") renderMethod();
    if (S.view === "files") renderFiles();
    if (S.view === "about") renderAbout();
  }

  // ---------- facts used in the explanatory texts (all computed from the data) ----------
  function apFor(ds, lat, lon) {
    const W = D["windows_" + ds]; let b = -1, bd = 1e9;
    for (let i = 0; i < W.lat.length; i++) { const d = Math.abs(W.lat[i] - lat) + Math.abs(W.lon[i] - lon); if (d < bd) { bd = d; b = i; } }
    return bd < 0.02 ? W.ap[b] : "";
  }
  function teamNames(id, mode) {
    const tw = twinFor(id, mode), ds = D.twins[id].dataset;
    return tw ? tw.members.map((m) => siteName(m.site, m.lat, m.lon, apFor(ds, m.lat, m.lon))).join(" + ") : "–";
  }
  function facts() {
    const V = D.validation, avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const best = (id) => {
      const W = D["windows_" + (bodyOf(id) === "moon" ? "moon40" : "mars200")], sc = W.scores[id].genel;
      const bT = bestIdx(W, sc, ["turkey", "scan"]), bK = bestIdx(W, sc, ["known"]);
      return { W, bT, bK, s: sc[bT], k: sc[bK], ratio: 100 * sc[bT] / sc[bK] };
    };
    const sh = best("Moon_Shackleton"), me = best("Mars_Meridiani_Oppy");
    const rob = (id) => (V.weights.find((r) => r.target === id) || {})["tr_en_iyi_ayni_kaldi_%"];
    const months = [...new Set(TARGET_ORDER.map((id) => { const b = best(id), c = D.climate[b.W.site[b.bT]]; return c && c.best !== null ? c.best : null; })
      .filter((m) => m !== null))].sort((a, b) => a - b).map((m) => t("monl." + m));
    const auc = (ds, lay) => avg(V.base.filter((r) => r.veri === ds && r.katmanlar === lay).map((r) => r.AUC));
    const loo = V.loo.filter((r) => r.veri === "moon40" || r.veri === "mars200");
    const modeAuc = (ds, m) => (V.modes.find((r) => r.veri === ds && r.mod === m) || {}).AUC;
    const maxDiff = Math.max(...["moon40", "mars200"].flatMap((ds) => ["inis", "rover", "us"].map((m) => Math.abs(modeAuc(ds, m) - modeAuc(ds, "genel")))));
    const shM = meta("Moon_Shackleton");
    const kTw = ((twinFor("Moon_Shackleton", "genel") || { members: [] }).members.find((m) => m.site === sh.W.site[sh.bT])) || { lat: sh.W.lat[sh.bT], lon: sh.W.lon[sh.bT] };
    let ki = 0, kd = 1e9;
    sh.W.lat.forEach((la, i) => { const d = Math.abs(la - kTw.lat) + Math.abs(sh.W.lon[i] - kTw.lon); if (d < kd) { kd = d; ki = i; } });
    return {
      kesis: siteName(sh.W.site[sh.bT]), shs: fmt(sh.s, 1), shk: siteName(sh.W.site[sh.bK]), shks: fmt(sh.k, 1), shr: fmt(sh.ratio, 0), shrob: fmt(rob("Moon_Shackleton"), 0),
      tsl: fmt(sh.W.f.slope_mean[ki], 1), ssl: fmt(shM.features.slope_mean, 1),
      tst: fmt(100 * sh.W.f.steep_frac[ki], 0), sst: fmt(100 * shM.features.steep_frac, 0), tp90: fmt(sh.W.f.slope_p90[ki], 1), sp90: fmt(shM.features.slope_p90, 1),
      mer: siteName(me.W.site[me.bT]), merr: fmt(me.ratio, 0),
      land: teamNames("Moon_Shackleton", "inis"), rover: teamNames("Moon_Shackleton", "rover"), drill: teamNames("Moon_Shackleton", "sondaj"),
      months: months.join(" / "),
      am: fmt(auc("moon40", "terrain_barren"), 2), amt: fmt(auc("moon40", "terrain"), 2), ama: fmt(auc("mars200", "terrain_barren"), 2), amat: fmt(auc("mars200", "terrain"), 2),
      loo: loo.filter((r) => r.en_iyi_ust_yuzde <= 6).length, n: loo.length, md: fmt(maxDiff, 2),
      sdm: fmt(modeAuc("moon40", "sondaj"), 2), sda: fmt(modeAuc("mars200", "sondaj"), 2),
      miss: (twinFor("Moon_Shackleton", "genel") || { missing: [] }).missing.map((c) => t("feat." + c)).join(", ") || "–"
    };
  }

  // ---------- explorer: intro ----------
  function renderIntro() {
    const f = facts();
    $("#intro").innerHTML = `<p class="lede">${t("intro.lede")}</p>
      <div>
        <details class="more" open><summary>${t("how.t")}</summary>
          <p style="margin:0"><b>${t("how.who.t")}</b> ${t("how.who")}</p>
          <p style="margin:6px 0 0"><b>${t("how.what.t")}</b> ${t("how.what")}</p>
          <ol>${[1, 2, 3, 4].map((k) => `<li>${t("how.s" + k)}</li>`).join("")}</ol>
          <p style="margin:6px 0 0"><b>${t("how.score.t")}</b> ${t("how.score")}</p>
          <p style="margin:6px 0 0">${t("how.pages")}</p></details>
      </div>`;
  }

  // ---------- explorer: controls ----------
  function renderControls() {
    $("#tlist").innerHTML = TARGET_ORDER.map((id) => {
      const m = meta(id);
      return `<button type="button" class="tbtn" data-t="${id}" aria-pressed="${id === S.target}">
        <span class="dot ${bodyOf(id)}"></span><span>${esc(targetName(id))}</span>
        <small>${t("body." + bodyOf(id))} · ${fmt(m.lat, 2)}°, ${fmt(m.lon, 2)}°</small></button>`;
    }).join("");
    $("#modes").innerHTML = D.meta.modes.map((m) => `<button type="button" data-m="${m}" aria-pressed="${m === S.mode}">${t("mode." + m)}</button>`).join("");
    $("#modehint").textContent = t("mode." + S.mode + ".hint");
    $("#modelong").innerHTML = t("modes." + S.mode);
    $("#modemore").querySelector("summary").textContent = t("mode.more");
    $("#dsgroup").hidden = bodyOf(S.target) !== "mars";
    $("#dsseg").innerHTML = ["mars200", "mars463"].map((d) => `<button type="button" data-ds="${d}" aria-pressed="${d === S.marsDs}">${t("ds." + d)}</button>`).join("");
    const L = [["known", "#f6e3cf", "#3b0d11"], ["turkey", "#c9533c", "#1b1b1b"], ["scan", "#933058", "#1b1b1b"], ["control", "#9a9a9a", "#7d7d7d"]];
    $("#layerchecks").innerHTML = L.map(([k, f, s]) => `<label><input type="checkbox" id="lyr-${k}" data-ly="${k}" ${S.layers[k] ? "checked" : ""}>
      <span class="swatch" style="background:${f};border-color:${s}"></span>${t("group." + k)}</label>`).join("");
  }

  // ---------- explorer: map ----------
  function baseLayers(m) {
    const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 17, attribution: "Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community" });
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 17, attribution: "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors" });
    let errors = 0, loaded = 0;
    sat.on("tileerror", () => { errors++; if (errors > 6 && loaded === 0) offlineBase(m); });
    sat.on("tileload", () => loaded++);
    sat.addTo(m);
    L.control.layers({ [t("map.sat")]: sat, [t("map.osm")]: osm }, null, { position: "topright", collapsed: false }).addTo(m);
    L.control.scale({ imperial: false }).addTo(m);
  }
  function offlineBase(m) {
    if (m._offline) return; m._offline = true;
    const el = m === map ? $("#offline") : null;
    if (el) { el.hidden = false; el.textContent = t("map.offline"); }
    if (D.countries) L.geoJSON(D.countries, { style: { color: css("--muted"), weight: 0.8, fill: true, fillColor: css("--sunk"), fillOpacity: 1 }, interactive: false }).addTo(m);
    m.getContainer().style.background = css("--bg");
  }
  function renderMap() {
    if (!map) {
      map = L.map("map", { worldCopyJump: true, minZoom: 2 }).setView([30, 10], 2);
      baseLayers(map);
      winLayer = L.layerGroup().addTo(map);
      extraLayer = L.layerGroup().addTo(map);
    }
    winLayer.clearLayers(); extraLayer.clearLayers();
    const { W, sc } = view();
    const vals = sc.filter((v, i) => v !== null && S.layers[W.group[i]]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const order = sc.map((v, i) => i).sort((a, b) => (sc[a] ?? -1) - (sc[b] ?? -1));   // high scores drawn on top
    for (const i of order) {
      const g = W.group[i];
      if (!S.layers[g] || sc[i] === null) continue;
      const st = GROUP_STYLE[g];
      const c = L.circleMarker([W.lat[i], W.lon[i]], {
        radius: g === "known" || g === "turkey" ? 7 : 5, color: st.color, weight: st.weight, fillColor: g === "control" ? "#9a9a9a" : rampColor((sc[i] - lo) / (hi - lo || 1)), fillOpacity: 0.95
      });
      c.bindTooltip(`${esc(siteName(W.site[i], W.lat[i], W.lon[i], W.ap[i]))} · ${fmt(sc[i], 1)}`);
      c.on("click", () => c.bindPopup(popupHTML(W, sc, i), { maxWidth: 300 }).openPopup());
      c.addTo(winLayer);
    }
    $("#legend").innerHTML = `<span class="eyebrow">${t("legend.title")}</span>
      <div class="ramp" style="background:linear-gradient(90deg,${RAMP.join(",")})"></div>
      <div class="ramp-l"><span>${fmt(lo, 0)}</span><span>${t("legend.mid")}</span><span>${fmt(hi, 0)}</span></div>`;
    // twin team members as numbered rings
    const tw = twinFor(S.target, S.mode);
    if (tw) tw.members.forEach((m, k) => {
      L.marker([m.lat, m.lon], { icon: L.divIcon({ className: "", html: `<div style="width:24px;height:24px;border-radius:50%;background:#fff;color:#111;border:3px solid ${css("--accent")};display:grid;place-items:center;font:600 12px var(--mono)">${k + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
        .bindTooltip(`${t("twin.member")} ${k + 1}: ${esc(siteName(m.site, m.lat, m.lon))}`).addTo(extraLayer);
    });
  }
  function popupHTML(W, sc, i) {
    const rank = 1 + sc.filter((v) => v !== null && v > sc[i]).length, n = sc.filter((v) => v !== null).length;
    const strip = W.strip[i] ? `<p class="note warn" style="margin:6px 0 0">${t("warn.strip", { s: esc(W.strip[i]) })}</p>` : "";
    return `<div style="display:grid;gap:4px">
      <b>${esc(siteName(W.site[i], W.lat[i], W.lon[i], W.ap[i]))}</b>
      <span class="eyebrow">${t("group." + W.group[i])}</span>
      <dl class="kv"><dt>${t("ui.score")}</dt><dd class="num">${fmt(sc[i], 1)} · ${t("ui.rank", { r: rank, n })}</dd>
      <dt>${t("ui.rock")}</dt><dd>${t("rock." + (W.rock[i] || "unknown"))}</dd>
      <dt>${t("ui.barren")}</dt><dd class="num">${pct(W.f.w_barren_frac[i])}</dd>
      <dt>${t("ui.airport")}</dt><dd>${esc(W.ap[i])} ${W.iata[i] ? "(" + esc(W.iata[i]) + ")" : ""} · <span class="num">${fmt(W.ap_km[i], 0)} km</span></dd>
      <dt>${t("ui.coords")}</dt><dd class="num">${fmt(W.lat[i], 3)}, ${fmt(W.lon[i], 3)}</dd></dl>${strip}
      <a href="${gmaps(W.lat[i], W.lon[i])}" target="_blank" rel="noopener">${t("ui.gmaps")}</a></div>`;
  }

  // ---------- explorer: detail panel ----------
  function twinFor(id, mode) { const tw = D.twins[id]; return tw ? tw[mode] : null; }
  function renderDetail() {
    const id = S.target, m = meta(id), { W, sc } = view();
    const bE = bestIdx(W, sc, ["known", "turkey", "scan"]), bT = bestIdx(W, sc, ["turkey", "scan"]), bK = bestIdx(W, sc, ["known"]);
    const tw = twinFor(id, S.mode);
    const card = D.cards.find((c) => c.target === id);
    const rob = (D.validation.weights || []).find((r) => r.target === id);
    let h = `<header style="display:grid;gap:4px"><span class="eyebrow">${t("body." + bodyOf(id))} · ${t("mode." + S.mode)}</span>
      <h2>${esc(targetName(id))}</h2><p class="hint">${t("target." + id + ".about")}</p></header>`;

    h += `<div class="best">
      <div class="stat"><span class="eyebrow">${t("best.earth")}</span><span class="big">${fmt(sc[bE], 1)}</span>
        <span class="where">${esc(siteName(W.site[bE], W.lat[bE], W.lon[bE], W.ap[bE]))}</span></div>
      <div class="stat"><span class="eyebrow">${t("best.turkey")}</span><span class="big">${fmt(sc[bT], 1)}</span>
        <span class="where">${esc(siteName(W.site[bT], W.lat[bT], W.lon[bT], W.ap[bT]))}</span>
        <span class="src">${t("best.ratio", { p: fmt(100 * sc[bT] / sc[bK], 0) })}</span></div></div>`;
    if (W.strip[bT]) h += `<p class="note warn">${t("warn.strip", { s: esc(W.strip[bT]) })}</p>`;
    if (rob && S.mode === "genel" && dsOf(id) !== "mars463") {
      const p = rob["tr_en_iyi_ayni_kaldi_%"];
      h += `<p class="note ${p < 50 ? "warn" : ""}">${t(p < 50 ? "rob.unstable" : "rob.stable", { p })}</p>`;
    }
    const rs = S.mode === "genel" ? robSite(dsOf(id), id, W.site[bT]) : null;
    if (rs && rs["tr_birinci_%"] !== null) h += `<p class="note">${t("rob.site", { s: esc(siteName(W.site[bT], W.lat[bT], W.lon[bT], W.ap[bT])), a: rs["tr_birinci_%"], b: rs["ilk3_%"], n: D.robust_sites.draws })}</p>`;

    // twin team
    if (tw) {
      h += `<section style="display:grid;gap:8px"><h3>${t("twin.title")}</h3><p class="hint">${t("twin.hint")}</p>
        <ol class="team">${tw.members.map((mm) => `<li><span class="nm">${esc(siteName(mm.site, mm.lat, mm.lon))}</span>
        <span class="chips">${mm.covers.map((c) => `<span class="chip">${t("feat." + c)}</span>`).join("")}</span></li>`).join("")}</ol>
        <div style="display:grid;gap:4px"><span class="src">${t("twin.coverage", { p: fmt(tw.coverage, 0) })}</span><div class="bar"><i style="width:${tw.coverage}%"></i></div></div>
        ${tw.missing.length ? `<div class="chips"><span class="src">${t("twin.missing")}</span>${tw.missing.map((c) => `<span class="chip miss">${t("feat." + c)}</span>`).join("")}</div>` : ""}
        ${D.twins[id].dataset !== dsOf(id) ? `<p class="note">${t("twin.ds200")}</p>` : ""}</section>`;
    }

    // side-by-side card
    if (card) {
      const im = (k) => card.img && card.img[k] ? `img/cards/${id}_${k}.jpg` : "";
      const fig = (k, cap) => `<figure>${im(k) ? `<img src="${im(k)}" alt="${esc(cap)}" loading="lazy">` : `<div class="cards4-empty"></div>`}<figcaption>${cap}</figcaption></figure>`;
      h += `<section style="display:grid;gap:8px"><h3>${t("card.title")}</h3><p class="hint">${t("card.hint", { site: esc(siteName(card.site, card.lat, card.lon)) })}</p>
        <div class="cards4">${fig("target", t("card.target", { r: fmt(card.res_t, 0), ex: card.ex > 1 ? t("card.ex", { x: card.ex }) : "" }))}
        ${fig("earth", t("card.earth", { s: fmt(card.score, 1) }))}${fig("rgb", t("card.rgb", { d: card.rgb_date || "–" }))}${fig("wc", t("card.wc"))}</div>
        <p class="src">${t("card.src")}</p></section>`;
    }

    // features
    h += `<section style="display:grid;gap:8px"><h3>${t("feat.title")}</h3><div class="tbl"><table><thead><tr><th>${t("feat.col")}</th>
      <th class="n">${t("feat.target")}</th><th class="n">${t("feat.tr")}</th><th class="n">${t("feat.known")}</th></tr></thead><tbody>`;
    for (const [f, fm] of FEATS) {
      const tv = f === "w_barren_frac" ? 1 : m.features[f];
      h += `<tr><td>${t("feat." + f)}</td><td class="n">${fm(tv)}</td><td class="n">${bT >= 0 ? fm(W.f[f][bT]) : "–"}</td><td class="n">${bK >= 0 ? fm(W.f[f][bK]) : "–"}</td></tr>`;
    }
    h += `</tbody></table></div><p class="src">${t("feat.note", { k: esc(siteName(W.site[bK], W.lat[bK], W.lon[bK])) })}</p></section>`;

    // calendar for Türkiye best site
    const clim = D.climate[W.site[bT]];
    if (clim) {
      h += `<section style="display:grid;gap:6px"><h3>${t("cal.title")}</h3><p class="hint">${t("cal.hint", { site: esc(siteName(W.site[bT], W.lat[bT], W.lon[bT], W.ap[bT])) })}</p>
        <div class="months">${clim.status.map((s, k) => `<div class="m${s}" title="${t("cal.s" + s)} · ${fmt(clim.T[k], 1)} °C · ${fmt(clim.P[k], 2)} mm/d">${t("mon." + k)}${s === 3 ? "<br>★" : ""}</div>`).join("")}</div>
        <div class="chips">${[0, 1, 2, 3].map((s) => `<span class="chip m${s}">${t("cal.s" + s)}</span>`).join("")}</div>
        ${clim.best !== null ? `<p class="src">${t("cal.best", { m: t("monl." + clim.best), T: fmt(clim.T[clim.best], 1), P: fmt(clim.P[clim.best], 2) })}</p>` : ""}
        ${clim.relaxed ? `<p class="note">${t("cal.relaxed")}</p>` : ""}</section>`;
    }

    // layers the model cannot see
    h += `<details class="layer" open><summary>${t("hidden.title")}</summary><div>`;
    const rt = D.rock.targets.find((r) => r.site === id);
    h += `<h3 style="font-size:1rem">${t("ui.rock")}</h3><dl class="kv"><dt>${esc(targetName(id))}</dt><dd><span class="chip rock">${t("rock." + (m.rock || "unknown"))}</span>
      ${m.rock_override ? `<span class="src"> · ${t("rock.override." + id)}</span>` : ""}</dd>
      <dt>${t("best.turkey")}</dt><dd><span class="chip rock">${t("rock." + (W.rock[bT] || "unknown"))}</span></dd></dl>
      <p class="src">${t("rock.src." + bodyOf(id))}${rt ? " · " + esc(rt.unit) : ""}</p>`;
    const mn = window.I18N.en["mineral." + id] ? t("mineral." + id) : null;
    if (mn) h += `<h3 style="font-size:1rem">${t("mineral.title")}</h3><p style="margin:0;font-size:.88rem">${mn}</p>`;
    const emitIds = { Mars_Meridiani_Oppy: ["tuzgolu_east", "tuzgolu"], Mars_Jezero: ["salda"], Mars_Gusev_Spirit: ["kula"] }[id] || [];
    if (D.emit && emitIds.length) {
      h += `<div class="tbl"><table><thead><tr><th>${t("emit.site")}</th><th>${t("emit.scene")}</th><th class="n">${t("emit.det")}</th></tr></thead><tbody>` +
        emitIds.map((e) => D.emit.find((r) => r.id === e)).filter(Boolean).map((r) => `<tr><td>${t("emit." + r.id)}</td>
        <td class="num">${esc(r.sahne)} · v${esc(r.surum)}</td><td class="n">${fmt(r["grup2_tespit_%"], 0)}% / ${fmt(r["grup1_tespit_%"], 0)}%</td></tr>`).join("") +
        `</tbody></table></div><p class="src">${t("emit.note." + id)}</p>`;
    }
    // soil and ice
    const pts = D.extra.points.filter((p) => p.target === id);
    h += `<h3 style="font-size:1rem">${t("extra.title")}</h3><p class="hint">${t("extra.hint")}</p>
      <dl class="kv"><dt>${esc(targetName(id))}</dt><dd>${bodyOf(id) === "mars" ? t("extra.ti", { v: esc(D.extra.mars_ti[id]) }) : t("extra.moonsoil")}<br>${t("ice." + id)}</dd>`;
    for (const p of pts) {
      const e = D.extra.earth.find((x) => Math.abs(x.lat - p.lat) < 1e-6 && Math.abs(x.lon - p.lon) < 1e-6);
      if (!e) continue;
      const soil = e.sand === null ? t("extra.nosoil") : t("extra.soil", { s: fmt(e.sand, 0), c: fmt(e.clay, 0), g: fmt(e.cfvo, 0), b: fmt(e.bdod, 2) });
      const role = p.rol === "Türkiye en iyi" ? t("best.turkey") : t("twin.title");
      h += `<dt>${esc(siteName(p.site, p.lat, p.lon))}<br><span class="src">${role}</span></dt><dd>${soil}<br>${t("pf." + (e.permafrost || "none"))}</dd>`;
    }
    h += `</dl><p class="src">${t("extra.src." + bodyOf(id))}</p></div></details>`;
    $("#detail").innerHTML = h;
  }

  // ---------- findings view ----------
  function renderFindings() {
    const f = facts();
    $("#findings").innerHTML = `<header><span class="eyebrow">${t("nav.findings")}</span><h2>${t("find.t")}</h2><p class="lede">${t("find.lede")}</p></header>
      <div class="kpis">
        <div class="kpi"><span class="eyebrow">${t("target.Moon_Shackleton")}</span><span class="big num">${f.shs}</span><p>${esc(f.kesis)} · ${t("best.ratio", { p: f.shr })}</p></div>
        <div class="kpi"><span class="eyebrow">${t("target.Mars_Meridiani_Oppy")}</span><span class="big num">${f.merr}%</span><p>${esc(f.mer)} · ${t("find.k.mer")}</p></div>
        <div class="kpi"><span class="eyebrow">${t("val.k.loo.t")}</span><span class="big num">${f.loo}/${f.n}</span><p>${t("val.k.loo")}</p></div>
      </div>
      <ol style="margin:0;padding-left:22px;display:grid;gap:12px">${["kesis", "mer", "modes", "when"].map((k) => `<li>${t("find." + k, f)}</li>`).join("")}<li id="find-rover" hidden></li><li>${t("find.limits", f)}</li></ol>
      <p class="note">${t("find.more")}</p>${artemisHTML()}`;
    roverFinding();
  }
  // ---------- Artemis candidate landing regions (scored with the main scaling; other results unchanged) ----------
  function artemisHTML() {
    const A = D.artemis; if (!A || !A.regions || !A.regions.length) return "";
    const W = D.windows_moon40;
    const nm = (x) => { const k = W.site.findIndex((s, i) => s === x.site && Math.abs(W.lat[i] - x.lat) < 1e-3 && Math.abs(W.lon[i] - x.lon) < 1e-3);
      return esc(siteName(x.site, x.lat, x.lon, k >= 0 ? W.ap[k] : apFor("moon40", x.lat, x.lon))); };
    const cnt = {}; A.regions.forEach((r) => { cnt[r.best_tr.site] = (cnt[r.best_tr.site] || 0) + 1; });
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0], ex = A.regions.find((r) => r.best_tr.site === top[0]).best_tr;
    const rows = A.regions.slice().sort((a, b) => a.lat - b.lat).map((r) => `<tr><td><b>${esc(r.region.replace(/_/g, " "))}</b><br><span class="src num">${fmt(r.lat, 2)}, ${fmt(r.lon, 2)}</span></td>
      <td>${nm(r.top[0])}<br><span class="src">${t("group." + r.top[0].group)}</span></td><td class="n">${fmt(r.top[0].score, 1)}</td>
      <td>${nm(r.best_tr)}</td><td class="n">${fmt(r.best_tr.score, 1)}</td></tr>`).join("");
    return `<section class="section"><h3>${t("art.t")}</h3><p style="margin:0">${t("art.p")}</p>
      <p style="margin:0">${t("art.find", { s: nm(ex), n: top[1], all: A.regions.length })}</p>
      <div class="tbl"><table><thead><tr><th>${t("art.col.region")}</th><th>${t("best.earth")}</th><th class="n">${t("ui.score")}</th><th>${t("best.turkey")}</th><th class="n">${t("ui.score")}</th></tr></thead>
      <tbody>${rows}</tbody></table></div><p class="src">${t("art.src")}</p></section>`;
  }
  async function roverFinding() {                    // computed from the rover grids with the same planner as the Rover page
    const el = $("#find-rover"); if (!el) return;
    try {
      const ids = ["Moon_Shackleton", "Moon_deGerlache", "Moon_Malapert"], pair = ["Moon_deGerlache", "Moon_Malapert"];
      for (const id of ids) if (!RV.data[id]) RV.data[id] = await getJSON("rover/" + id);
      const s1 = ROVER.Moon.presets[0][1], s2 = ROVER.Moon.presets[1][1], sp = ROVER.Moon.speed, pause = () => new Promise((r) => setTimeout(r, 0));
      let n = 0;
      for (const id of ids) { n = Math.max(n, rvRun(RV.data[id].terrains[0], s1, sp).found); await pause(); }
      const A = [], B = [], TT = [];
      for (const id of pair) for (const T of RV.data[id].terrains) {
        if (T.label === "world") continue;
        const r = rvRun(T, s2, sp); (T.label === "target" ? A : B).push(r.found); if (r.timeM !== null) TT.push(r.timeM); await pause();
      }
      const rng = (a) => Math.min(...a) === Math.max(...a) ? `${a[0]}/${N_PAIRS}` : `${Math.min(...a)}–${Math.max(...a)}/${N_PAIRS}`;
      const tt = TT.length ? `${fmt(Math.min(...TT), 1)}–${fmt(Math.max(...TT), 1)} ${t("rv.h")}` : "–";
      if (!document.body.contains(el)) return;
      el.innerHTML = t("find.rover", { s1, s2, n, a: rng(A), b: rng(B), t: tt }); el.hidden = false;
    } catch (e) { /* rover data not available: the item stays hidden */ }
  }

  // ---------- Türkiye view ----------
  function robCell(r) {
    const rs = robSite(bodyOf(r.id) === "moon" ? "moon40" : "mars200", r.id, r.W.site[r.i]);
    return rs && rs["tr_birinci_%"] !== null ? `<b>${rs["tr_birinci_%"]}%</b><br><span class="src">${t("rob.top3", { b: rs["ilk3_%"] })}</span>` : "–";
  }
  function renderTurkey() {
    const rows = TARGET_ORDER.map((id) => {
      const W = D["windows_" + (bodyOf(id) === "moon" ? "moon40" : "mars200")], sc = W.scores[id].genel;
      const bT = bestIdx(W, sc, ["turkey", "scan"]), bK = bestIdx(W, sc, ["known"]);
      const cl = D.climate[W.site[bT]];
      return { id, W, i: bT, s: sc[bT], ratio: 100 * sc[bT] / sc[bK], month: cl && cl.best !== null ? t("monl." + cl.best) : "–" };
    });
    const SC = Object.assign({ cell_deg: 0.1, min_barren: 0.3, max_sites: 25, min_sep_deg: 0.3 }, (D.meta && D.meta.scan) || {});
    const Wm = D.windows_moon40, nScan = new Set(Wm.site.filter((s, i) => Wm.group[i] === "scan")).size;
    const nFromScan = rows.filter((r) => r.W.group[r.i] === "scan").length;
    const why = { cell: fmt(SC.cell_deg, 1), km: fmt(SC.cell_deg * 111, 0), pct: fmt(100 * SC.min_barren, 0), sep: fmt(SC.min_sep_deg, 1),
      n: nScan, k: nFromScan, all: rows.length };
    let h = `<header><span class="eyebrow">${t("nav.turkey")}</span><h2>${t("tr.title")}</h2><p class="lede">${t("tr.lede")}</p></header>
      <section class="section"><h3>${t("tr.why.t")}</h3><p style="margin:0 0 8px">${t("tr.why.p")}</p>
      <ol style="margin:0 0 8px;padding-left:20px;display:grid;gap:6px"><li>${t("tr.why.hand")}</li><li>${t("tr.why.scan", why)}</li></ol>
      <p style="margin:0">${t("tr.why.res", why)}</p></section>
      <div id="trmap" role="region" aria-label="Map"></div>
      <p class="src">${t("tr.mapnote")}${D.countries ? " " + t("tr.mapnote.border") : ""}</p>
      ${D.cells ? `<div id="trcell" class="cellbox" aria-live="polite"><p class="hint" style="margin:0">${t("cell.hint", { n: D.cells.cells.length, p: fmt(100 * D.cells.min_barren, 0) })}</p></div>` : ""}
      <section class="section"><h3>${t("tr.table")}</h3><div class="tbl"><table><thead><tr><th>${t("ui.target")}</th><th>${t("tr.site")}</th>
      <th class="n">${t("ui.score")}</th><th class="n">${t("tr.ratio")}</th><th>${t("tr.month")}</th><th>${t("ui.airport")}</th>${D.robust_sites ? `<th class="n">${t("rob.col")}</th>` : ""}</tr></thead><tbody>` +
      rows.map((r) => `<tr><td>${esc(targetName(r.id))}</td><td><a href="${gmaps(r.W.lat[r.i], r.W.lon[r.i])}" target="_blank" rel="noopener">${esc(siteName(r.W.site[r.i], r.W.lat[r.i], r.W.lon[r.i], r.W.ap[r.i]))}</a>
        ${r.W.strip[r.i] ? `<br><span class="src">${t("warn.strip", { s: esc(r.W.strip[r.i]) })}</span>` : ""}</td>
        <td class="n">${fmt(r.s, 1)}</td><td class="n">${fmt(r.ratio, 0)}%</td><td>${r.month}</td><td>${esc(r.W.ap[r.i])} · <span class="num">${fmt(r.W.ap_km[r.i], 0)} km</span></td>${D.robust_sites ? `<td class="n">${robCell(r)}</td>` : ""}</tr>`).join("") +
      `</tbody></table></div>${D.robust_sites ? `<p class="src">${t("rob.col.h", { n: D.robust_sites.draws })}</p>` : ""}</section>
      <section class="section"><h3>${t("tr.heat.t")}</h3><p class="hint">${t("tr.heat.h")}</p>${heatmapHTML()}</section>
      ${soilCardsHTML()}
      <section class="section"><h3>${t("tr.checked")}</h3><ul style="margin:0;padding-left:20px;display:grid;gap:6px">
        <li>${t("tr.check.kesis", facts())}</li><li>${t("tr.check.toros")}</li><li>${t("tr.check.tuz", facts())}</li><li>${t("tr.check.igdir")}</li></ul></section>
      <section class="section"><h3>${t("tr.known")}</h3><p style="margin:0">${t("tr.salda")}${whySrc("TR_Salda")}</p></section>
      <figure style="margin:0;display:grid;gap:6px"><img src="img/fig/fig_turkey_scan.png" alt="${t("tr.figalt")}" loading="lazy" style="border:1px solid var(--line);border-radius:6px;background:#fff">
      <figcaption class="src">${t("tr.figcap")}</figcaption></figure>`;
    $("#turkey").innerHTML = h;
    if (trmap) { trmap.remove(); trmap = null; }
    trmap = L.map("trmap", { minZoom: 4 }).setView([39.0, 35.3], 6);
    baseLayers(trmap);
    if (D.countries) L.geoJSON({ type: "FeatureCollection", features: D.countries.features.filter((f) => f.properties && f.properties.iso === "TUR") },
      { style: { color: "#F2C48D", weight: 2, fill: false, dashArray: "6 4" }, interactive: false }).addTo(trmap);
    const G = D.scan_grid;
    for (let k = 0; k < G.lat.length; k++) {
      if (G.barren[k] === null || G.barren[k] < 0.05) continue;
      L.rectangle([[G.lat[k] - 0.05, G.lon[k] - 0.05], [G.lat[k] + 0.05, G.lon[k] + 0.05]],
        { stroke: false, fillColor: rampColor(G.barren[k]), fillOpacity: 0.55, interactive: false }).addTo(trmap);
    }
    if (D.cells) {
      D.cells.cells.forEach((c) => L.rectangle([[c.lat - 0.05, c.lon - 0.05], [c.lat + 0.05, c.lon + 0.05]],
        { color: "#F2C48D", weight: 1, fill: false, interactive: false }).addTo(trmap));
      trmap.on("click", (e) => showCell(e.latlng.lat, e.latlng.lng, rows));
    }
    rows.forEach((r, k) => {
      L.marker([r.W.lat[r.i], r.W.lon[r.i]], { icon: L.divIcon({ className: "", html: `<div style="width:26px;height:26px;border-radius:50%;background:${bodyOf(r.id) === "moon" ? "#d9d9d9" : css("--mars")};color:#111;border:2px solid #111;display:grid;place-items:center;font:600 11px var(--mono)">${bodyOf(r.id) === "moon" ? "☾" : "♂"}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
        .bindTooltip(`${esc(targetName(r.id))} → ${esc(siteName(r.W.site[r.i], r.W.lat[r.i], r.W.lon[r.i], r.W.ap[r.i]))} · ${fmt(r.s, 1)}`).addTo(trmap);
    });
  }

  // ---------- clickable Türkiye cells ----------
  function showCell(lat, lon, rows) {
    const box = $("#trcell"); if (!box) return;
    const G = D.scan_grid, C = D.cells;
    let k = -1, bd = 1e9;
    for (let i = 0; i < G.lat.length; i++) { const d = Math.max(Math.abs(G.lat[i] - lat), Math.abs(G.lon[i] - lon)); if (d < bd) { bd = d; k = i; } }
    if (k < 0 || bd > 0.051) { box.innerHTML = `<p class="hint" style="margin:0">${t("cell.outside")}</p>`; return; }
    const glat = G.lat[k], glon = G.lon[k], bar = G.barren[k];
    const head = `<b>${t("cell.title", { lat: fmt(glat, 2), lon: fmt(glon, 2) })}</b> · <span class="src">${t("cell.barren", { p: bar === null ? "–" : fmt(100 * bar, 0) })}</span>`;
    const c = C.cells.find((x) => Math.abs(x.lat - glat) < 1e-3 && Math.abs(x.lon - glon) < 1e-3);
    if (!c) {
      const why = bar === null ? "cell.nodata" : bar < C.min_barren ? "cell.veg" : "cell.excluded";
      box.innerHTML = `<p style="margin:0">${head}</p><p class="note" style="margin:6px 0 0">${t(why, { p: fmt(100 * C.min_barren, 0) })}</p>`; return;
    }
    const trBest = (id) => { const r = rows.find((x) => x.id === id); return r ? r.s : null; };
    const main = TARGET_ORDER.filter((id) => c.s[id] !== undefined && c.s[id] !== null && trBest(id));
    const ratio = (id) => 100 * c.s[id] / trBest(id);          // scores are compared within a target, never across Moon and Mars
    const best = main.reduce((a, b) => (ratio(b) > ratio(a) ? b : a), main[0]);
    const art = (D.artemis && D.artemis.regions || []).filter((r) => c.s[r.id] !== undefined).sort((a, b) => c.s[b.id] - c.s[a.id]);
    box.innerHTML = `<p style="margin:0">${head}</p>
      <p style="margin:6px 0 0">${t("cell.best", { t: esc(targetName(best)), p: fmt(ratio(best), 0) })} ${t("ui.airport")}: ${esc(c.ap)}${c.iata ? " (" + esc(c.iata) + ")" : ""} · <span class="num">${fmt(c.ap_km, 0)} km</span></p>
      <div class="tbl"><table><thead><tr><th>${t("ui.target")}</th><th class="n">${t("cell.col.this")}</th><th class="n">${t("cell.col.trbest")}</th><th class="n">${t("cell.col.ratio")}</th></tr></thead><tbody>` +
      main.map((id) => `<tr${id === best ? ' style="font-weight:600"' : ""}><td>${esc(targetName(id))}</td><td class="n">${fmt(c.s[id], 1)}</td><td class="n">${fmt(trBest(id), 1)}</td><td class="n">${fmt(ratio(id), 0)}%</td></tr>`).join("") +
      `</tbody></table></div>` +
      (art.length ? `<p class="src" style="margin:4px 0 0">${t("cell.art", { r: esc(art[0].region.replace(/_/g, " ")), s: fmt(c.s[art[0].id], 1) })}</p>` : "") +
      `<p class="src" style="margin:4px 0 0">${t("cell.note")} · <a href="${gmaps(glat, glon)}" target="_blank" rel="noopener">${t("ui.gmaps")}</a></p>`;
  }

  function heatmapHTML() {
    const modes = D.meta.modes, cells = [];
    TARGET_ORDER.forEach((id) => modes.forEach((m) => {
      const W = D["windows_" + (bodyOf(id) === "moon" ? "moon40" : "mars200")], sc = (W.scores[id] || {})[m] || [];
      const i = bestIdx(W, sc, ["turkey", "scan"]);
      cells.push({ id, m, s: i >= 0 ? sc[i] : null, site: i >= 0 ? siteName(W.site[i], W.lat[i], W.lon[i], W.ap[i]) : "" });
    }));
    const v = cells.map((c) => c.s).filter((x) => x !== null), lo = Math.min(...v), hi = Math.max(...v);
    const cell = (c) => {
      const x = (c.s - lo) / (hi - lo || 1), bg = rampColor(x), fg = x > 0.55 ? "#1b1b1b" : "#fff";
      return `<td class="n" style="background:${bg};color:${fg}" title="${esc(c.site)}">${fmt(c.s, 0)}</td>`;
    };
    return `<div class="tbl"><table class="heat"><thead><tr><th>${t("ui.target")}</th>${modes.map((m) => `<th class="n">${t("mode." + m)}</th>`).join("")}</tr></thead><tbody>` +
      TARGET_ORDER.map((id) => `<tr><td>${esc(targetName(id))}</td>${modes.map((m) => cell(cells.find((c) => c.id === id && c.m === m))).join("")}</tr>`).join("") +
      `</tbody></table></div>`;
  }

  // ---------- shared helpers for the planner, field check and soil cards ----------
  function winNear(ds, lat, lon) {                  // nearest window in a dataset (for airport and features of a team member)
    const W = D["windows_" + ds]; let b = -1, bd = 1e9;
    for (let i = 0; i < W.lat.length; i++) { const d = Math.abs(W.lat[i] - lat) + Math.abs(W.lon[i] - lon); if (d < bd) { bd = d; b = i; } }
    return { W, i: b };
  }
  const monthOf = (site) => { const c = D.climate[site]; return c && c.best !== null ? t("monl." + c.best) : "–"; };
  const apText = (W, i) => i < 0 || !W.ap[i] ? "–" : `${esc(W.ap[i])}${W.iata[i] ? " (" + esc(W.iata[i]) + ")" : ""} · <span class="num">${fmt(W.ap_km[i], 0)} km</span>`;
  const isTR = (site) => site.startsWith("SCAN_") || site.startsWith("TR_");

  // ---------- test campaign planner ----------
  function renderPlan() {
    const id = S.planT || S.target, mode = S.planM || S.mode, tw = twinFor(id, mode), ds = D.twins[id] ? D.twins[id].dataset : dsOf(id);
    const Wb = D["windows_" + ds], sc = (Wb.scores[id] || {})[mode] || [], bT = bestIdx(Wb, sc, ["turkey", "scan"]);
    const rob = (D.validation.weights || []).find((r) => r.target === id && r.veri === ds);
    const today = new Intl.DateTimeFormat(S.lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date());
    let rows = "";
    if (tw) tw.members.forEach((m, k) => {
      const { W, i } = winNear(ds, m.lat, m.lon);
      rows += `<tr><td class="n">${k + 1}</td><td><b>${esc(siteName(m.site, m.lat, m.lon, W.ap[i]))}</b><br><span class="src">${t("group." + m.group)}</span></td>
        <td><span class="chips">${m.covers.map((c) => `<span class="chip">${t("feat." + c)}</span>`).join("")}</span></td>
        <td>${monthOf(m.site)}</td><td>${apText(W, i)}</td><td class="num">${fmt(m.lat, 3)}, ${fmt(m.lon, 3)}</td></tr>`;
    });
    let h = `<header class="noprint"><span class="eyebrow">${t("nav.plan")}</span><h2>${t("pl.title")}</h2><p class="lede">${t("pl.lede")}</p></header>
      <section class="section rv-controls noprint"><div><span class="label">${t("ui.target")}</span><div class="seg">${TARGET_ORDER.map((x) =>
        `<button data-pt="${x}" aria-pressed="${x === id}">${esc(targetName(x))}</button>`).join("")}</div></div>
        <div><span class="label">${t("ui.mode")}</span><div class="seg">${D.meta.modes.map((x) => `<button data-pm="${x}" aria-pressed="${x === mode}">${t("mode." + x)}</button>`).join("")}</div>
        <p class="hint" style="margin:6px 0 0">${t("mode." + mode + ".hint")}</p></div></section>
      <article class="plan" id="plancard">
        <header style="display:grid;gap:2px"><span class="eyebrow">Mirror Terrain · ${t("pl.kind")}</span><h3 style="font-size:1.35rem">${t("pl.card", { t: esc(targetName(id)) })}</h3>
          <span class="src">${t("pl.purpose", { m: t("mode." + mode) })} · ${t("body." + bodyOf(id))} · ${esc(today)}</span></header>`;
    if (tw) {
      h += `<section style="display:grid;gap:6px"><h4>${t("pl.team")}</h4><div class="tbl"><table><thead><tr><th class="n">#</th><th>${t("pl.col.site")}</th><th>${t("pl.col.covers")}</th>
        <th>${t("pl.col.month")}</th><th>${t("ui.airport")}</th><th>${t("ui.coords")}</th></tr></thead><tbody>${rows}</tbody></table></div>
        <span class="src">${t("pl.coverage", { p: fmt(tw.coverage, 0) })}</span><div class="bar"><i style="width:${tw.coverage}%"></i></div>
        ${tw.missing.length ? `<div class="chips"><span class="src">${t("twin.missing")}</span>${tw.missing.map((c) => `<span class="chip miss">${t("feat." + c)}</span>`).join("")}</div>` : ""}</section>`;
    }
    if (bT >= 0) {
      const site = Wb.site[bT];
      h += `<section style="display:grid;gap:6px"><h4>${t("pl.tr")}</h4><dl class="kv">
        <dt>${t("pl.col.site")}</dt><dd><b>${esc(siteName(site, Wb.lat[bT], Wb.lon[bT], Wb.ap[bT]))}</b> · <span class="num">${fmt(Wb.lat[bT], 3)}, ${fmt(Wb.lon[bT], 3)}</span></dd>
        <dt>${t("ui.score")}</dt><dd class="num">${fmt(sc[bT], 1)}</dd>
        <dt>${t("pl.col.month")}</dt><dd>${monthOf(site)}</dd><dt>${t("ui.airport")}</dt><dd>${apText(Wb, bT)}</dd></dl>
        ${Wb.strip[bT] ? `<p class="note warn">${t("warn.strip", { s: esc(Wb.strip[bT]) })}</p>` : ""}
        ${rob && mode === "genel" ? `<p class="note ${rob["tr_en_iyi_ayni_kaldi_%"] < 50 ? "warn" : ""}">${t(rob["tr_en_iyi_ayni_kaldi_%"] < 50 ? "rob.unstable" : "rob.stable", { p: rob["tr_en_iyi_ayni_kaldi_%"] })}</p>` : ""}${(() => { const rs = mode === "genel" ? robSite(ds, id, site) : null;
          return rs && rs["tr_birinci_%"] !== null ? `<p class="note">${t("rob.site", { s: esc(siteName(site, Wb.lat[bT], Wb.lon[bT], Wb.ap[bT])), a: rs["tr_birinci_%"], b: rs["ilk3_%"], n: D.robust_sites.draws })}</p>` : ""; })()}</section>`;
    }
    h += `<p class="note">${t("pl.note")}</p><p class="src">${t("pl.src")} · talyamorgul.github.io/mirror-terrain</p></article>
      <div class="noprint" style="display:grid;gap:4px;justify-items:start"><button type="button" class="btn" id="planpdf">${t("pl.pdf")}</button><span class="hint">${t("pl.pdf.h")}</span></div>`;
    $("#planv").innerHTML = h;
  }

  // ---------- field check plan ----------
  function renderField() {
    const pick = (id, ds) => { const W = D["windows_" + ds], sc = W.scores[id].genel, i = bestIdx(W, sc, ["turkey", "scan"]); return { W, i }; };
    const K = pick("Moon_Shackleton", "moon40"), Tm = pick("Mars_Meridiani_Oppy", "mars200"), Tr = pick("Moon_Malapert", "moon40");
    const T40 = winNear("moon40", Tm.W.lat[Tm.i], Tm.W.lon[Tm.i]);               // Lake Tuz window at the same 40 m resolution as Keşiş
    const soil = (lat, lon) => { let b = null, bd = 1e9; for (const e of D.extra.earth) { const d = Math.abs(e.lat - lat) + Math.abs(e.lon - lon); if (d < bd) { bd = d; b = e; } } return bd < 0.2 ? b : null; };
    const sites = [
      { k: "kesis", W: K.W, i: K.i, w40: K, s: soil(K.W.lat[K.i], K.W.lon[K.i]) },
      { k: "toros", W: Tr.W, i: Tr.i, w40: Tr, s: soil(Tr.W.lat[Tr.i], Tr.W.lon[Tr.i]) },
      { k: "tuz", W: Tm.W, i: Tm.i, w40: T40, s: soil(Tm.W.lat[Tm.i], Tm.W.lon[Tm.i]) }
    ];
    const val = (x) => {
      const W = x.w40.W, i = x.w40.i, f = W.f;
      return {
        slope: t("fd.c.slope.val", { a: fmt(f.slope_mean[i], 1), b: fmt(100 * f.steep_frac[i], 0) }),
        cover: t("fd.c.cover.val", { a: pct(f.w_barren_frac[i]) }),
        soil: x.s && x.s.sand !== null ? t("fd.c.soil.val", { s: fmt(x.s.sand, 0), c: fmt(x.s.clay, 0), g: fmt(x.s.cfvo, 0) }) : t("soil.none"),
        min: x.k === "tuz" ? t("fd.c.min.val") : "–",
        access: t("fd.c.access.val", { km: fmt(x.W.ap_km[x.i], 0), ap: esc(x.W.ap[x.i]) })
      };
    };
    const V = sites.map(val);
    const checks = ["slope", "cover", "soil", "min", "access"];
    let h = `<header><span class="eyebrow">${t("nav.field")}</span><h2>${t("fd.title")}</h2><p class="lede">${t("fd.lede")}</p></header>
      <section class="section"><h3>${t("fd.sites")}</h3><div class="grid3">${sites.map((x) => `<div class="kpi">
        <span class="eyebrow">${t("fd.for." + x.k)}</span><b style="font-size:1.1rem">${esc(siteName(x.W.site[x.i], x.W.lat[x.i], x.W.lon[x.i], x.W.ap[x.i]))}</b>
        <p>${t("fd.site." + x.k)}</p><p>${t("pl.col.month")}: ${monthOf(x.W.site[x.i])} · ${t("ui.airport")}: ${apText(x.W, x.i)}</p>
        <p class="num">${fmt(x.W.lat[x.i], 3)}, ${fmt(x.W.lon[x.i], 3)} · <a href="${gmaps(x.W.lat[x.i], x.W.lon[x.i])}" target="_blank" rel="noopener">${t("ui.gmaps")}</a></p></div>`).join("")}</div></section>
      <section class="section"><h3>${t("fd.checks")}</h3><div class="tbl"><table><thead><tr><th>${t("fd.col.what")}</th><th>${t("fd.col.how")}</th>
        ${sites.map((x) => `<th>${esc(siteName(x.W.site[x.i], x.W.lat[x.i], x.W.lon[x.i], x.W.ap[x.i]))}</th>`).join("")}<th>${t("fd.col.src")}</th></tr></thead><tbody>` +
      checks.map((c) => `<tr><td><b>${t("fd.c." + c)}</b></td><td>${t("fd.c." + c + ".how")}</td>${V.map((v) => `<td>${v[c]}</td>`).join("")}<td class="src">${t("fd.c." + c + ".src")}</td></tr>`).join("") +
      `</tbody></table></div><p class="src">${t("fd.res")}</p></section>
      <section class="section"><h3>${t("fd.rule.t")}</h3><p style="margin:0">${t("fd.rule")}</p><p class="note">${t("fd.lim")}</p></section>`;
    $("#fieldv").innerHTML = h;
  }

  // ---------- soil cards (Türkiye page; shown, not scored) ----------
  function soilCardsHTML() {
    const by = new Map();
    for (const p of D.extra.points) {
      if (!isTR(p.site)) continue;
      const e = D.extra.earth.find((x) => Math.abs(x.lat - p.lat) < 1e-6 && Math.abs(x.lon - p.lon) < 1e-6); if (!e) continue;
      const k = p.site; if (!by.has(k)) by.set(k, { p, e, targets: new Set() });
      if (p.rol === "Türkiye en iyi" && by.get(k).p.rol !== "Türkiye en iyi") Object.assign(by.get(k), { p, e });   // same window as the Türkiye table and Field check
      by.get(k).targets.add(p.target);
    }
    if (!by.size) return "";
    const bar = (label, v, max, unit) => `<div style="display:grid;grid-template-columns:7.5em 1fr 3.6em;gap:8px;align-items:center;font-size:.84rem">
      <span>${label}</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, 100 * v / max))}%;background:var(--earth)"></i></div><span class="num" style="text-align:right">${fmt(v, unit === "%" ? 0 : 2)}${unit === "%" ? "%" : ""}</span></div>`;
    return `<section class="section"><h3>${t("soil.t")}</h3><p class="hint">${t("soil.h")}</p><div class="soilcards">` +
      [...by.values()].map(({ p, e, targets }) => `<div class="kpi"><b>${esc(siteName(p.site, p.lat, p.lon, apFor("moon40", p.lat, p.lon)))}</b>
        <span class="src">${t("soil.for", { t: [...targets].map((x) => esc(targetName(x))).join(", ") })}</span>
        ${e.sand === null ? `<p>${t("soil.none")}</p>` : bar(t("soil.sand"), e.sand, 100, "%") + bar(t("soil.clay"), e.clay, 100, "%") + bar(t("soil.cfvo"), e.cfvo, 100, "%") +
          `<p>${t("soil.bdod")}: <span class="num">${fmt(e.bdod, 2)} g/cm³</span></p>`}
        <p>${t("pf." + (e.permafrost || "none"))}</p></div>`).join("") +
      `</div><p class="src">${t("extra.src.moon")}</p></section>`;
  }

  // ---------- validation view ----------
  function renderValidation() {
    const V = D.validation, avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const auc = (ds, lay) => avg(V.base.filter((r) => r.veri === ds && r.katmanlar === lay).map((r) => r.AUC));
    const looFound = (ds) => V.loo.filter((r) => r.veri === ds && r.en_iyi_ust_yuzde <= 6).length;
    const looN = (ds) => V.loo.filter((r) => r.veri === ds).length;
    let h = `<header><span class="eyebrow">${t("nav.validation")}</span><h2>${t("val.title")}</h2><p class="lede">${t("val.lede")}</p></header>
      <div class="kpis">
        <div class="kpi"><span class="eyebrow">${t("body.moon")} · AUC</span><span class="big num">${fmt(auc("moon40", "terrain_barren"), 2)}</span><p>${t("val.k.moon", { x: fmt(auc("moon40", "terrain"), 2) })}</p></div>
        <div class="kpi"><span class="eyebrow">${t("body.mars")} · AUC</span><span class="big num">${fmt(auc("mars200", "terrain_barren"), 2)}</span><p>${t("val.k.mars", { x: fmt(auc("mars200", "terrain"), 2) })}</p></div>
        <div class="kpi"><span class="eyebrow">${t("val.k.loo.t")}</span><span class="big num">${looFound("moon40") + looFound("mars200")}/${looN("moon40") + looN("mars200")}</span><p>${t("val.k.loo")}</p></div>
      </div>
      <section class="section"><h3>${t("val.auc.t")}</h3><p class="hint">${t("val.auc.h")}</p><div class="chartbox"><canvas id="c-auc"></canvas></div></section>
      <section class="section"><h3>${t("val.modes.t")}</h3><p class="hint">${t("val.modes.h")}</p><div class="chartbox"><canvas id="c-modes"></canvas></div></section>
      <section class="section"><h3>${t("val.rob.t")}</h3><p class="hint">${t("val.rob.h")}</p>
        <div class="chartbox" style="height:${60 + 34 * V.weights.length}px"><canvas id="c-rob"></canvas></div><div class="tbl"><table><thead><tr><th>${t("ui.target")}</th><th>${t("best.turkey")}</th>
        <th class="n">${t("val.rob.same")}</th><th class="n">${t("val.rob.score")}</th><th class="n">AUC (5–95%)</th></tr></thead><tbody>` +
      V.weights.map((r) => `<tr><td>${esc(targetName(r.target))}</td><td>${esc(siteName(r.tr_en_iyi, 0, 0))}</td>
        <td class="n"><b>${fmt(r["tr_en_iyi_ayni_kaldi_%"], 0)}%</b></td><td class="n">${fmt(r.tr_skor, 1)} (${fmt(r.tr_skor_p5, 1)}–${fmt(r.tr_skor_p95, 1)})</td>
        <td class="n">${fmt(r.AUC_genel, 2)} (${fmt(r.AUC_p5, 2)}–${fmt(r.AUC_p95, 2)})</td></tr>`).join("") +
      `</tbody></table></div></section>
      <section class="section"><h3>${t("val.loo.t")}</h3><p class="hint">${t("val.loo.h")}</p><div class="tbl"><table><thead><tr><th>${t("val.loo.site")}</th>
        <th class="n">${t("body.moon")}</th><th class="n">${t("body.mars")}</th></tr></thead><tbody>` +
      [...new Set(V.loo.map((r) => r.disarida_birakilan))].map((s) => {
        const g = (ds) => { const r = V.loo.find((x) => x.veri === ds && x.disarida_birakilan === s); return r ? `${t("val.top", { p: fmt(r.en_iyi_ust_yuzde, 1) })}` : "–"; };
        return `<tr><td>${esc(siteName(s, 0, 0))}</td><td class="n">${g("moon40")}</td><td class="n">${g("mars200")}</td></tr>`;
      }).join("") + `</tbody></table></div><p class="note">${t("val.loo.read")}</p></section>
      <section class="section"><h3>${t("val.limits.t")}</h3><ul style="margin:0;padding-left:20px;display:grid;gap:6px">
        <li>${t("val.lim1")}</li><li>${t("val.lim2")}</li><li>${t("val.lim3")}</li><li>${t("val.lim4")}</li></ul></section>`;
    $("#validation").innerHTML = h;
    const ink = css("--ink"), muted = css("--muted"), line = css("--line");
    Chart.defaults.color = muted; Chart.defaults.borderColor = line; Chart.defaults.font.family = css("--body");
    const tg = TARGET_ORDER;
    charts.push(new Chart($("#c-auc"), {
      type: "bar", data: {
        labels: tg.map((x) => targetName(x)),
        datasets: [["terrain", css("--earth")], ["terrain_barren", css("--mars")]].map(([lay, col]) => ({
          label: t("val.lay." + lay), backgroundColor: col,
          data: tg.map((x) => { const r = V.base.find((b) => b.target === x && b.katmanlar === lay && b.veri === (bodyOf(x) === "moon" ? "moon40" : "mars200")); return r ? r.AUC : null; })
        }))
      }, options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 1, title: { display: true, text: "AUC" } }, x: { ticks: { color: ink } } },
        plugins: { annotation: {}, legend: { position: "bottom" } } }
    }));
    const wr = V.weights;
    charts.push(new Chart($("#c-rob"), {
      type: "bar", data: {
        labels: wr.map((r) => targetName(r.target)),
        datasets: [{ label: t("val.rob.same"), data: wr.map((r) => r["tr_en_iyi_ayni_kaldi_%"]),
          backgroundColor: wr.map((r) => r["tr_en_iyi_ayni_kaldi_%"] >= 50 ? css("--good") : css("--warn")) }]
      }, options: { indexAxis: "y", maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { min: 0, max: 100, title: { display: true, text: t("val.rob.same") + " (%)" } }, y: { ticks: { color: ink } } } }
    }));
    const modes = D.meta.modes, dss = ["moon40", "mars200", "mars463"], pal = [css("--muted"), css("--earth"), css("--mars")];
    charts.push(new Chart($("#c-modes"), {
      type: "bar", data: {
        labels: modes.map((m) => t("mode." + m)),
        datasets: dss.map((ds, k) => ({ label: t("ds.full." + ds), backgroundColor: pal[k], data: modes.map((m) => { const r = V.modes.find((x) => x.veri === ds && x.mod === m); return r ? r.AUC : null; }) }))
      }, options: { maintainAspectRatio: false, scales: { y: { min: 0.4, max: 1, title: { display: true, text: "AUC" } }, x: { ticks: { color: ink } } }, plugins: { legend: { position: "bottom" } } }
    }));
  }

  // ---------- method view ----------
  function renderMethod() {
    const W = D.meta.weights, cols = Object.keys(W.genel).concat(["rock_match"]).filter((v, i, a) => a.indexOf(v) === i);
    let h = `<header><span class="eyebrow">${t("nav.method")}</span><h2>${t("me.title")}</h2><p class="lede">${t("me.lede")}</p></header>
      <section class="section"><h3>${t("me.steps")}</h3><ol class="steps">${[1, 2, 3, 4, 5, 6, 7, 8].map((k) => `<li><div><b>${t("me.s" + k + ".t")}</b><span>${t("me.s" + k)}</span></div></li>`).join("")}</ol></section>
      <section class="section"><h3>${t("me.air.t")}</h3><p style="margin:0">${t("me.air")}</p></section>
      <section class="section"><h3>${t("me.feats")}</h3><div class="tbl"><table><thead><tr><th>${t("feat.col")}</th><th>${t("me.def")}</th></tr></thead><tbody>
        ${FEATS.map(([f]) => `<tr><td>${t("feat." + f)}</td><td>${t("def." + f)}</td></tr>`).join("")}<tr><td>${t("feat.rock_match")}</td><td>${t("def.rock_match")}</td></tr></tbody></table></div></section>
      <section class="section"><h3>${t("me.weights")}</h3><p class="hint">${t("me.weights.h")}</p><div class="tbl"><table><thead><tr><th>${t("ui.mode")}</th>
        ${cols.map((c) => `<th class="n">${t("feat." + c)}</th>`).join("")}</tr></thead><tbody>
        ${D.meta.modes.map((m) => `<tr><td>${t("mode." + m)}</td>${cols.map((c) => `<td class="n">${W[m][c] !== undefined ? fmt(W[m][c], 2) : "–"}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>
      <section class="section"><h3>${t("modes.t")}</h3><p style="margin:0">${t("modes.p")}</p>
        <dl class="gloss">${D.meta.modes.map((m) => `<dt>${t("mode." + m)}</dt><dd>${t("modes." + m)}</dd>`).join("")}</dl>
        <p style="margin:0"><b>${t("modes.why.t")}</b> ${t("modes.why", facts())}</p>
        <p style="margin:0"><b>${t("modes.ex.t")}</b> ${t("modes.ex", facts())}</p></section>
      <section class="section"><h3>${t("gl.t")}</h3><dl class="gloss">${GLOSS.map((k) => `<dt>${t("gl." + k + ".t")}</dt><dd>${t("gl." + k)}</dd>`).join("")}</dl></section>
      <section class="section"><h3>${t("st.t")}</h3><p class="hint">${t("st.h")}</p>${sitesTable()}</section>
      <section class="section"><h3>${t("me.sources")}</h3><ul class="srcs">${SOURCES.map((s) => `<li><a href="${s[1]}" target="_blank" rel="noopener">${esc(s[0])}</a> · <span class="src">${t(s[2])}${s[3] ? " · " + esc(s[3]) : ""}</span></li>`).join("")}</ul></section>
      <section class="section"><h3>${t("rep.t")}</h3><ol style="margin:0;padding-left:22px;display:grid;gap:6px">${[1, 2, 3, 4, 5].map((k) => `<li>${t("rep." + k)}</li>`).join("")}</ol></section>
      <section class="section"><h3>${t("me.future")}</h3><p class="hint">${t("me.future.h")}</p><div class="tbl"><table><thead><tr><th>${t("me.layer")}</th><th>${t("me.why")}</th></tr></thead><tbody>
        ${["soil", "ice", "cave", "temp", "mineral"].map((k) => `<tr><td>${t("fw." + k + ".t")}</td><td>${t("fw." + k)}</td></tr>`).join("")}</tbody></table></div></section>`;
    $("#method").innerHTML = h;
  }
  const WHY_SRC = {
    DeathValley: ["NASA Earth Observatory 2012", "https://science.nasa.gov/earth/earth-observatory/mars-rover-curiosity-on-a-familiar-landscape-78860/"],
    Atacama_Yungay: ["NASA Astrobiology, ARADS", "https://astrobiology.nasa.gov/news/nasa-tests-life-detection-drill-in-the-atacama-desert/"],
    MeteorCrater: ["Vaughan et al. 2019, GSA Field Guide 55", "https://doi.org/10.1130/2019.0055(12)"],
    Hawaii_MaunaKea: ["Captain et al. 2010, NASA NTRS", "https://ntrs.nasa.gov/citations/20100033667"],
    Iceland_Holuhraun: ["Voigt et al. 2025, Planet. Sci. J.", "https://doi.org/10.3847/PSJ/adb5f1"],
    Haughton: ["Space.com 2015", "https://www.space.com/31312-mock-mars-mission-devon-island.html"],
    Svalbard_Bockfjorden: ["AMASE field sites", "https://homepages.see.leeds.ac.uk/~earlgb/AMASE/field_sites.html"],
    TR_Kula: ["Tokçaer et al. 2005, Turk. J. Earth Sci.", "https://aj.tubitak.gov.tr/earth/issues/yer-05-14-2/yer-14-2-2-0508-1.pdf"],
    TR_Kapadokya: ["Mues-Schumacher et al. 2004, Turk. J. Earth Sci.", "https://aj.tubitak.gov.tr/earth/issues/yer-04-13-3/yer-13-3-1-0307-1.pdf"],
    TR_TuzGolu: ["Kılıç & Kılıç 2010, Sci. Res. Essays", "https://avesis.cu.edu.tr/yayin/16696f04-038b-4848-9ca6-c732dc382593/tuz-kabugu-mineralojisi-ve-turkiyedeki-tuz-golunun-jeokimyasal-evrimi"],
    TR_Nemrut: ["MTA, Türkiye volcanoes", "https://mta.gov.tr/turkvolc/en/nemrut"],
    TR_Salda: ["NASA Earth Matters 2021", "https://science.nasa.gov/blogs/earth-matters/2021/02/17/what-a-lake-in-turkey-can-tell-us-about-mars/"],
  };
  const whySrc = (site) => WHY_SRC[site] ? ` <span class="src">(<a href="${WHY_SRC[site][1]}" target="_blank" rel="noopener">${esc(WHY_SRC[site][0])}</a>)</span>` : "";
  function sitesTable() {
    const W = D.windows_moon40, by = {};
    W.site.forEach((st, i) => { const g = W.group[i]; const k = g === "scan" ? "__scan" : st;
      (by[k] = by[k] || { site: st, group: g, n: 0, lat: 0, lon: 0, cells: new Set() }); by[k].n++; by[k].lat += W.lat[i]; by[k].lon += W.lon[i]; by[k].cells.add(st); });
    const order = { known: 0, turkey: 1, scan: 2, control: 3 };
    const rows = Object.values(by).sort((a, b) => order[a.group] - order[b.group] || a.site.localeCompare(b.site));
    return `<div class="tbl"><table><thead><tr><th>${t("st.site")}</th><th>${t("st.group")}</th><th class="n">${t("st.coord")}</th><th class="n">${t("st.n")}</th><th>${t("st.why")}</th></tr></thead><tbody>` +
      rows.map((r) => r.group === "scan"
        ? `<tr><td>${t("st.scan", { c: r.cells.size })}</td><td>${t("role.scan")}</td><td class="n">–</td><td class="n">${r.n}</td><td>${t("why.scan")}</td></tr>`
        : `<tr><td>${esc(siteName(r.site))}</td><td>${t("role." + r.group)}</td><td class="n">${fmt(r.lat / r.n, 2)}°, ${fmt(r.lon / r.n, 2)}°</td><td class="n">${r.n}</td><td>${t("why." + r.site)}${whySrc(r.site)}</td></tr>`).join("") +
      `</tbody></table></div><p class="src">${t("st.note")}</p>`;
  }
  const GLOSS = ["analog", "window", "score", "twin", "coverage", "barren", "hyps", "auc", "loo", "pf", "ti"];
  const SOURCES = [
    ["NASA LRO LOLA – South pole DEM, 40 m (LDEM_80S_40MPP_ADJ)", "https://pgda.gsfc.nasa.gov/products/90", "src.moon", "NASA"],
    ["USGS Astrogeology – Mars HRSC + MOLA blended DEM, 200 m", "https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m", "src.mars", "NASA, ESA/DLR, USGS"],
    ["USGS Astrogeology – Mars MOLA DEM, 463 m", "https://astrogeology.usgs.gov/search/map/mars_mgs_mola_dem_463m", "src.mars", "NASA, USGS"],
    ["NASA NASADEM & Copernicus GLO-30 (via OpenTopography)", "https://opentopography.org/", "src.earthdem", "NASA, ESA/Copernicus"],
    ["ESA WorldCover 2021, 10 m", "https://esa-worldcover.org/", "src.wc", "© ESA WorldCover project, CC BY 4.0"],
    ["Sentinel-2 L2A (Copernicus, AWS Open Data / Earth Search)", "https://registry.opendata.aws/sentinel-2-l2a-cogs/", "src.s2", "Contains modified Copernicus Sentinel data"],
    ["NASA POWER – climatology API", "https://power.larc.nasa.gov/", "src.power", "NASA"],
    ["NASA EMIT L2B Mineral Identification (LP DAAC)", "https://www.earthdata.nasa.gov/data/catalog/lpcloud-emitl2bmin-002", "src.emit", "NASA"],
    ["Macrostrat geologic map API", "https://macrostrat.org/", "src.macro", "CC BY 4.0"],
    ["USGS SIM 3292 – Geologic Map of Mars (Tanaka et al. 2014)", "https://astrogeology.usgs.gov/pygeoapi/collections", "src.rock", "USGS"],
    ["USGS Unified Geologic Map of the Moon, 1:5M (2020)", "https://astrogeology.usgs.gov/search/map/unified_geologic_map_of_the_moon_1_5m_2020", "src.rock", "USGS"],
    ["ISRIC SoilGrids 2.0", "https://soilgrids.org/", "src.soil", "CC BY 4.0"],
    ["Obu et al. 2019 – Northern Hemisphere permafrost zonation (PANGAEA)", "https://apgc.awi.de/dataset/pex/resource/e9f1ab3a-2b75-4b49-9355-6b36bba8a1d8", "src.pf", "CC BY 3.0"],
    ["OurAirports open data", "https://ourairports.com/data/", "src.air", "Public domain"],
    ["Natural Earth", "https://www.naturalearthdata.com/", "src.ne", "Public domain"]
  ];

  // ---------- files view ----------
  const FILES = ["features_earth.csv", "features_earth_40m.csv", "features_earth_200m.csv", "features_earth_462m.csv",
    "features_targets_moon.csv", "features_targets_mars.csv", "ranks_moon.csv", "ranks_mars_HRSC_MOLA_200m.csv",
    "ranks_mars_MOLA_463m.csv", "validation.csv", "twin_teams.csv", "modes_validation.csv", "modes_validation_summary.csv", "modes_best_windows.csv", "modes_twin_teams.csv",
    "turkey_discovery.csv", "scan_grid_turkey.csv", "candidate_cards.csv", "best_months.csv", "climate_monthly.csv", "climate_earth.csv", "rock_targets.csv", "rock_earth_v2.csv",
    "ek_tablo.csv", "ek_soilgrids.csv", "emit_minerals.csv", "emit_library.csv", "accessibility.csv", "robustness_weights.csv", "robustness_loo.csv"];
  const FIGS = ["fig_moon_targets", "fig_mars_targets_200m", "fig_turkey_scan", "fig_candidate_cards", "fig_best_month", "fig_modes", "fig_robustness"];
  const NOTEBOOK = "MirrorTerrain.ipynb";
  function renderFiles() {
    $("#filesv").innerHTML = `<header><span class="eyebrow">${t("nav.files")}</span><h2>${t("fi.title")}</h2><p class="lede">${t("fi.lede")}</p></header>
      <div class="tbl"><table><thead><tr><th>${t("fi.file")}</th><th>${t("fi.what")}</th></tr></thead><tbody>
      ${FILES.map((f) => `<tr><td><a class="mono" href="csv/${f}" download>${f}</a></td><td>${t("fi." + f.replace(".csv", ""))}</td></tr>`).join("")}</tbody></table></div>
      <section class="section"><h3>${t("fi.fig.t")}</h3><div class="tbl"><table><thead><tr><th>${t("fi.file")}</th><th>${t("fi.what")}</th></tr></thead><tbody>
      ${FIGS.map((f) => `<tr><td><a class="mono" href="img/dl/${f}.jpg" target="_blank" rel="noopener">${f}.jpg</a></td><td>${t("fi." + f)}</td></tr>`).join("")}</tbody></table></div></section>
      <section class="section"><h3>${t("fi.json.t")}</h3><div class="tbl"><table><thead><tr><th>${t("fi.file")}</th><th>${t("fi.what")}</th></tr></thead><tbody>
      <tr><td>${TARGET_ORDER.map((id) => `<a class="mono" href="data/rover/${id}.json" download>rover/${id}.json</a>`).join("<br>")}</td><td>${t("fi.rover")}</td></tr>
      <tr><td><a class="mono" href="data/countries.json" download>countries.json</a></td><td>${t("fi.countries")}</td></tr></tbody></table></div></section>
      <section class="section"><h3>${t("fi.nb.t")}</h3><p style="margin:0"><a class="mono" href="${NOTEBOOK}" download>${NOTEBOOK}</a> · ${t("fi.nb")}</p></section>
      <p class="note">${t("fi.code")}</p>`;
  }

  // ---------- rover view ----------
  // Rover values (sources listed on the page): VIPER slope 15° normal / 25° when necessary and ~0.72 km/h (NASA);
  // Curiosity steepest tilt reached on Mars 31° (NASA/JPL) and ~20 m/h on Mount Sharp (NASA/JPL).
  const ROVER = {
    Moon: { presets: [["viper", 15], ["viper_max", 25]], def: 15, speed: 720, speedKey: "rv.speed.moon" },
    Mars: { presets: [["curiosity", 31]], def: 31, speed: 20, speedKey: "rv.speed.mars" }
  };
  const RV = { target: "Moon_Shackleton", slope: null, data: {}, cam: { yaw: -0.6, pitch: 0.75, dist: 3.7 }, gls: [], token: 0 };
  const N_PAIRS = 20;
  function rvPairs() {                                  // same start-goal pairs on every terrain (fixed seed)
    let s = 42; const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const P = [[0.1, 0.9, 0.9, 0.1]];
    while (P.length < N_PAIRS) {
      const p = [0.05 + 0.9 * rnd(), 0.05 + 0.9 * rnd(), 0.05 + 0.9 * rnd(), 0.05 + 0.9 * rnd()];
      if (Math.hypot(p[2] - p[0], p[3] - p[1]) >= 0.5) P.push(p);
    }
    return P;
  }
  function decodeGrid(T) {
    const b = atob(T.data), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    const q = new Int16Array(u.buffer), z = new Float32Array(T.n * T.m);
    for (let i = 0; i < z.length; i++) z[i] = T.z0 + q[i] / T.scale;
    return z;
  }
  function slopeMap(z, n, m, res) {                      // degrees, central differences like numpy.gradient
    const s = new Float32Array(n * m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
      const iu = Math.max(i - 1, 0), id = Math.min(i + 1, n - 1), jl = Math.max(j - 1, 0), jr = Math.min(j + 1, m - 1);
      const gy = (z[id * m + j] - z[iu * m + j]) / ((id - iu) * res), gx = (z[i * m + jr] - z[i * m + jl]) / ((jr - jl) * res);
      s[i * m + j] = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    }
    return s;
  }
  function snap(ok, n, m, i, j) {                        // nearest drivable cell (within 10% of the window)
    const R = Math.ceil(0.1 * n);
    for (let r = 0; r <= R; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const a = i + di, b = j + dj;
      if (a >= 0 && a < n && b >= 0 && b < m && ok[a * m + b]) return a * m + b;
    }
    return -1;
  }
  function astar(z, ok, n, m, res, A, B) {
    const N = n * m, g = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const bi = (B / m) | 0, bj = B % m;
    const h = (k) => Math.hypot(((k / m) | 0) - bi, (k % m) - bj) * res;
    const hk = [], hf = [];                              // binary heap
    const push = (k, f) => { hk.push(k); hf.push(f); let c = hk.length - 1;
      while (c > 0) { const p = (c - 1) >> 1; if (hf[p] <= hf[c]) break; [hk[p], hk[c]] = [hk[c], hk[p]]; [hf[p], hf[c]] = [hf[c], hf[p]]; c = p; } };
    const pop = () => { const top = hk[0], lk = hk.pop(), lf = hf.pop();
      if (hk.length) { hk[0] = lk; hf[0] = lf; let c = 0;
        for (;;) { const l = 2 * c + 1, r = l + 1; let s = c;
          if (l < hk.length && hf[l] < hf[s]) s = l; if (r < hk.length && hf[r] < hf[s]) s = r;
          if (s === c) break; [hk[s], hk[c]] = [hk[c], hk[s]]; [hf[s], hf[c]] = [hf[c], hf[s]]; c = s; } }
      return top; };
    g[A] = 0; push(A, h(A));
    const D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
    while (hk.length) {
      const k = pop(); if (done[k]) continue; done[k] = 1;
      if (k === B) break;
      const i = (k / m) | 0, j = k % m;
      for (const [di, dj] of D) {
        const a = i + di, b = j + dj; if (a < 0 || a >= n || b < 0 || b >= m) continue;
        const q = a * m + b; if (!ok[q] || done[q]) continue;
        const c = g[k] + Math.hypot(Math.hypot(di, dj) * res, z[q] - z[k]);
        if (c < g[q]) { g[q] = c; from[q] = k; push(q, c + h(q)); }
      }
    }
    if (!done[B]) return null;
    const path = []; let climb = 0;
    for (let k = B; k !== -1; k = from[k]) { path.push(k); if (from[k] !== -1) climb += Math.max(0, z[k] - z[from[k]]); }
    return { len: g[B], climb, path: path.reverse() };
  }
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
  function rvRun(T, lim, speed) {                        // all route statistics for one terrain
    const n = T.n, m = T.m, res = T.res_m;
    if (!T.z) { T.z = decodeGrid(T); T.s = slopeMap(T.z, n, m, res); }
    const ok = new Uint8Array(n * m); let nok = 0;
    for (let k = 0; k < ok.length; k++) { ok[k] = T.s[k] <= lim ? 1 : 0; nok += ok[k]; }
    const out = { pass: nok / ok.length, found: 0, detour: [], climb: [], time: [], main: null, ok };
    rvPairs().forEach((p, idx) => {
      const A = snap(ok, n, m, Math.round(p[1] * (n - 1)), Math.round(p[0] * (m - 1)));
      const B = snap(ok, n, m, Math.round(p[3] * (n - 1)), Math.round(p[2] * (m - 1)));
      if (A < 0 || B < 0 || A === B) return;
      const r = astar(T.z, ok, n, m, res, A, B); if (!r) return;
      // detour relative to the shortest 8-direction grid path on open flat ground, so grid geometry alone gives 1.00
      const di = Math.abs(((A / m) | 0) - ((B / m) | 0)), dj = Math.abs((A % m) - (B % m));
      const octile = (Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj)) * res, euclid = Math.hypot(di, dj) * res;
      out.found++; out.detour.push(r.len / octile); out.climb.push(r.climb); out.time.push(r.len * (euclid / octile) / speed);
      if (idx === 0) out.main = r.path;
    });
    out.detourM = median(out.detour); out.climbM = median(out.climb); out.timeM = median(out.time);
    return out;
  }

  // --- minimal WebGL terrain viewer (no external library) ---
  function m4persp(f, a, n, fa) { const t_ = 1 / Math.tan(f / 2), nf = 1 / (n - fa);
    return [t_ / a, 0, 0, 0, 0, t_, 0, 0, 0, 0, (fa + n) * nf, -1, 0, 0, 2 * fa * n * nf, 0]; }
  function m4mul(a, b) { const o = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k]; return o; }
  function m4view(yaw, pitch, dist) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const ry = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
    const rx = [1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1];
    const tr = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -dist, 1];
    return m4mul(tr, m4mul(rx, ry));
  }
  const hex2rgb = (h) => { h = h.replace("#", ""); if (h.length === 3) h = [...h].map((c) => c + c).join(""); return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16) / 255); };
  function glViewer(canvas, T, R, exag) {
    const gl = canvas.getContext("webgl", { antialias: true });
    if (!gl) return null;
    const n = T.n, m = T.m, step = Math.max(1, Math.ceil(Math.max(n, m) / 150));
    const rows = Math.floor((n - 1) / step) + 1, cols = Math.floor((m - 1) / step) + 1, L = Math.max(n, m) * T.res_m;
    let zmin = Infinity; for (const v of T.z) zmin = Math.min(zmin, v);
    const P = (i, j, lift = 0) => [(j / (m - 1) - 0.5) * 2 * (m / Math.max(n, m)), (T.z[i * m + j] - zmin) * exag / L * 2 + lift, (i / (n - 1) - 0.5) * 2 * (n / Math.max(n, m))];
    const cOk = hex2rgb(css("--mars-soft") || "#f3d9cc"), cBad = hex2rgb(css("--bad") || "#a3322c");
    const pos = [], col = [], idx = [];
    const light = [0.45, 0.8, 0.35], ln = Math.hypot(...light);
    for (let a = 0; a < rows; a++) for (let b = 0; b < cols; b++) {
      const i = a * step, j = b * step; pos.push(...P(i, j));
      const iu = Math.max(i - step, 0), id = Math.min(i + step, n - 1), jl = Math.max(j - step, 0), jr = Math.min(j + step, m - 1);
      const dzx = (T.z[i * m + jr] - T.z[i * m + jl]) * exag / ((jr - jl) * T.res_m), dzy = (T.z[id * m + j] - T.z[iu * m + j]) * exag / ((id - iu) * T.res_m);
      const nx = -dzx, ny = 1, nz = -dzy, nl = Math.hypot(nx, ny, nz);
      const sh = 0.35 + 0.65 * Math.max(0, (nx * light[0] + ny * light[1] + nz * light[2]) / (nl * ln));
      const c = R.ok[i * m + j] ? cOk : cBad; col.push(c[0] * sh, c[1] * sh, c[2] * sh);
    }
    for (let a = 0; a < rows - 1; a++) for (let b = 0; b < cols - 1; b++) { const k = a * cols + b; idx.push(k, k + 1, k + cols, k + 1, k + cols + 1, k + cols); }
    const line = [];
    if (R.main) for (let q = 0; q < R.main.length; q += Math.max(1, Math.floor(step / 2))) { const k = R.main[q]; line.push(...P((k / m) | 0, k % m, 0.01)); }
    if (R.main) { const k = R.main[R.main.length - 1]; line.push(...P((k / m) | 0, k % m, 0.01)); }
    const full = [], cum = [0];                          // full-resolution route and distance along it (m), for the animation
    if (R.main) R.main.forEach((k, q) => { full.push(P((k / m) | 0, k % m, 0.012));
      if (q) { const a = R.main[q - 1], di = ((k / m) | 0) - ((a / m) | 0), dj = (k % m) - (a % m);
        cum.push(cum[q - 1] + Math.hypot(Math.hypot(di, dj) * T.res_m, T.z[k] - T.z[a])); } });
    const vs = "attribute vec3 p;attribute vec3 c;uniform mat4 M;varying vec3 v;uniform float ps;void main(){gl_Position=M*vec4(p,1.0);v=c;gl_PointSize=ps;}";
    const fs = "precision mediump float;varying vec3 v;void main(){gl_FragColor=vec4(v,1.0);}";
    const sh_ = (t_, s) => { const o = gl.createShader(t_); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    const pr = gl.createProgram(); gl.attachShader(pr, sh_(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh_(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
    const ext = gl.getExtension("OES_element_index_uint");
    const buf = (data, type = gl.ARRAY_BUFFER) => { const b = gl.createBuffer(); gl.bindBuffer(type, b); gl.bufferData(type, data, gl.STATIC_DRAW); return b; };
    const bP = buf(new Float32Array(pos)), bC = buf(new Float32Array(col)), bI = buf(ext ? new Uint32Array(idx) : new Uint16Array(idx), gl.ELEMENT_ARRAY_BUFFER);
    const lc = hex2rgb(css("--earth") || "#33478a"), bL = buf(new Float32Array(line)), bLC = buf(new Float32Array(line.length ? Array(line.length / 3).fill(lc).flat() : []));
    const ends = line.length ? new Float32Array([...line.slice(0, 3), ...line.slice(-3)]) : new Float32Array(0);
    const bE = buf(ends), bEC = buf(new Float32Array([0.18, 0.62, 0.32, 0.08, 0.08, 0.1]));
    const bM = buf(new Float32Array(3)), bMC = buf(new Float32Array(hex2rgb(css("--accent") || "#c45a1f")));
    const aP = gl.getAttribLocation(pr, "p"), aC = gl.getAttribLocation(pr, "c"), uM = gl.getUniformLocation(pr, "M"), uS = gl.getUniformLocation(pr, "ps");
    const bind = (bp, bc) => { gl.bindBuffer(gl.ARRAY_BUFFER, bp); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bc); gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 3, gl.FLOAT, false, 0, 0); };
    const bg = hex2rgb(css("--sunk") || "#ece6e3");
    function draw() {
      const w = canvas.clientWidth, hh = canvas.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
      gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(bg[0], bg[1], bg[2], 1); gl.enable(gl.DEPTH_TEST);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.useProgram(pr);
      const M = m4mul(m4persp(0.8, canvas.width / canvas.height, 0.05, 20), m4view(RV.cam.yaw, RV.cam.pitch, RV.cam.dist));
      gl.uniformMatrix4fv(uM, false, new Float32Array(M)); gl.uniform1f(uS, 9 * dpr);
      bind(bP, bC); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bI); gl.drawElements(gl.TRIANGLES, idx.length, ext ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
      if (line.length) { gl.disable(gl.DEPTH_TEST); bind(bL, bLC); gl.lineWidth(2); gl.drawArrays(gl.LINE_STRIP, 0, line.length / 3); bind(bE, bEC); gl.drawArrays(gl.POINTS, 0, 2); }
      if (RV.anim && full.length > 1) {                  // rover marker at distance RV.anim.d along the route
        const d = Math.min(RV.anim.d, cum[cum.length - 1]); let q = 1;
        while (q < cum.length - 1 && cum[q] < d) q++;
        const f = (d - cum[q - 1]) / Math.max(cum[q] - cum[q - 1], 1e-9), a = full[q - 1], b = full[q];
        gl.bindBuffer(gl.ARRAY_BUFFER, bM); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * f)), gl.DYNAMIC_DRAW);
        gl.uniform1f(uS, 15 * dpr); bind(bM, bMC); gl.drawArrays(gl.POINTS, 0, 1);
      }
    }
    draw.len = cum[cum.length - 1] || 0;
    draw();
    return draw;
  }
  function flatViewer(canvas, T, R) {                    // 2D fallback when WebGL is unavailable
    const n = T.n, m = T.m, ctx = canvas.getContext("2d"); canvas.width = m; canvas.height = n;
    const img = ctx.createImageData(m, n), cOk = hex2rgb(css("--mars-soft") || "#f3d9cc"), cBad = hex2rgb(css("--bad") || "#a3322c");
    for (let k = 0; k < n * m; k++) { const sh = 1 - Math.min(0.6, T.s[k] / 60), c = R.ok[k] ? cOk : cBad;
      img.data.set([c[0] * 255 * sh, c[1] * 255 * sh, c[2] * 255 * sh, 255], k * 4); }
    ctx.putImageData(img, 0, 0);
    if (R.main) { ctx.strokeStyle = css("--earth"); ctx.lineWidth = Math.max(1, n / 150); ctx.beginPath();
      R.main.forEach((k, q) => { const x = k % m, y = (k / m) | 0; q ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    canvas.style.imageRendering = "pixelated";
    return () => {};
  }

  function rvBtn(on) { const b = $("#rvplay"); if (b) { b.setAttribute("aria-pressed", on); b.textContent = (on ? "■ " : "▶ ") + t(on ? "rv.stop" : "rv.play"); } }
  function rvStop() { if (RV.raf) cancelAnimationFrame(RV.raf); RV.raf = 0; rvBtn(false); }
  function rvPlay() {                                    // all rovers drive at the same speed: a longer route finishes later
    if (RV.raf) { rvStop(); return; }
    const maxLen = Math.max(0, ...RV.gls.map((d) => d.len || 0)); if (!maxLen) return;
    // ?rvdur= (ms) only for recording a slow take
    const dur = +new URLSearchParams(location.search).get("rvdur") || 12000, t0 = performance.now(); RV.anim = { d: 0 };
    const step = () => { const now = performance.now(); RV.anim.d = maxLen * Math.min(1, (now - t0) / dur); RV.gls.forEach((d) => d());
      if (now - t0 < dur) RV.raf = requestAnimationFrame(step); else { RV.raf = 0; rvBtn(false); } };
    rvBtn(true); RV.raf = requestAnimationFrame(step);
  }
  async function renderRover() {
    rvStop(); RV.anim = null;
    const el = $("#roverv"), body = bodyOf(RV.target) === "moon" ? "Moon" : "Mars", RC = ROVER[body];
    if (RV.slope === null || RV.body !== body) { RV.slope = RC.def; RV.body = body; }
    el.innerHTML = `<header><span class="eyebrow">${t("nav.rover")}</span><h2>${t("rv.title")}</h2><p class="lede">${t("rv.lede", { n: N_PAIRS })}</p></header>
      <section class="section"><h3>${t("rv.how.t")}</h3><ol style="margin:0;padding-left:22px;display:grid;gap:6px">${[1, 2, 3].map((k) => `<li>${t("rv.how." + k, { n: N_PAIRS })}</li>`).join("")}</ol></section>
      <section class="section rv-controls"><div><span class="label">${t("ui.target")}</span><div class="seg">${TARGET_ORDER.map((id) =>
        `<button data-rt="${id}" aria-pressed="${id === RV.target}">${esc(targetName(id))}</button>`).join("")}</div></div>
        <div><span class="label">${t("rv.slope")}: <b class="num" id="rvslv">${RV.slope}°</b></span>
        <input type="range" id="rvsl" min="5" max="35" step="1" value="${RV.slope}" aria-label="${t("rv.slope")}" style="width:100%">
        <div class="chips">${RC.presets.map(([k, v]) => `<button class="chip" data-rp="${v}" aria-pressed="${v === RV.slope}">${t("rv.preset." + k, { v })}</button>`).join("")}</div></div></section>
      <div id="rvout"><p class="hint">${t("rv.loading")}</p></div>`;
    const token = ++RV.token;
    let D_ = RV.data[RV.target];
    if (!D_) {
      try { D_ = RV.data[RV.target] = await getJSON("rover/" + RV.target); } catch (e) { D_ = null; }
    }
    if (token !== RV.token) return;
    const out = $("#rvout");
    if (!D_) { out.innerHTML = `<p class="note">${t("rv.missing")}</p>`; return; }
    out.innerHTML = `<p class="hint">${t("rv.computing")}</p>`;
    await new Promise((r) => setTimeout(r, 30));
    const res = [];
    for (const T of D_.terrains) { res.push(rvRun(T, RV.slope, RC.speed)); await new Promise((r) => setTimeout(r, 0)); if (token !== RV.token) return; }
    let rmax = 0; D_.terrains.forEach((T) => { let a = Infinity, b = -Infinity; for (const v of T.z) { a = Math.min(a, v); b = Math.max(b, v); } rmax = Math.max(rmax, b - a); });
    const L = D_.terrains[0].n * D_.terrains[0].res_m, exag = Math.max(1, Math.min(10, Math.round(0.25 * L / Math.max(rmax, 1))));
    if (RV.fitFor !== RV.target) { RV.cam.dist = 3.4 + 2 * (2 * rmax * exag / L); RV.fitFor = RV.target; }   // fit tall terrains in view
    const nameOf = (T) => T.label === "target" ? targetName(T.site) : siteName(T.site, T.lat, T.lon);
    const hrs = (h) => h === null ? "–" : (h < 48 ? fmt(h, 1) + " " + t("rv.h") : fmt(h / 24, 1) + " " + t("rv.d"));
    const tgt = res[0];
    const dlt = (v, ref, d, unit = "") => { if (v === null || ref === null) return "";
      const x = +(v - ref).toFixed(d), sg = x > 0 ? "+" : x < 0 ? "−" : "±";
      return `<br><span class="src">${sg}${fmt(Math.abs(x), d)}${unit} ${t("rv.vs")}</span>`; };
    out.innerHTML = `<div class="rv-grid">${D_.terrains.map((T, i) => `<figure class="rv-card">
        <figcaption><span class="eyebrow">${t("rv.lab." + T.label)}</span><b>${esc(nameOf(T))}</b><span class="src">${fmt(T.res_m, 0)} m${T.score !== undefined ? ` · ${t("ui.score")} ${fmt(T.score, 1)}` : ""}</span></figcaption>
        <canvas class="rv-canvas" data-i="${i}" aria-label="${esc(nameOf(T))}"></canvas>${res[i].main ? "" : `<span class="src">${t("rv.nomain")}</span>`}</figure>`).join("")}</div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button class="chip" id="rvplay" aria-pressed="false">▶ ${t("rv.play")}</button>
      <p class="src" style="margin:0;flex:1 1 300px">${t("rv.view.h", { e: exag })}</p></div>
      ${res.every((r) => r.pass > 0.995) ? `<p class="note">${t("rv.allopen", { s: RV.slope, r: fmt(D_.terrains[0].res_m, 0) })}</p>` : ""}
      ${D_.terrains.some((T) => T.label === "world") ? "" : `<p class="note">${t("rv.sameworld")}</p>`}
      <div class="tbl"><table><thead><tr><th></th>${D_.terrains.map((T) => `<th>${t("rv.lab." + T.label)}</th>`).join("")}</tr></thead><tbody>
        <tr><td>${t("rv.pass")}</td>${res.map((r, i) => `<td class="n">${pct(r.pass)}${i ? dlt(r.pass * 100, tgt.pass * 100, 0, " " + t("rv.pp")) : ""}</td>`).join("")}</tr>
        <tr><td>${t("rv.ok")}</td>${res.map((r) => `<td class="n">${r.found} / ${N_PAIRS}</td>`).join("")}</tr>
        <tr><td>${t("rv.detour")}<br><span class="src">${t("rv.detour.h")}</span></td>${res.map((r, i) => `<td class="n">${fmt(r.detourM, 2)}${i ? dlt(r.detourM, tgt.detourM, 2) : ""}</td>`).join("")}</tr>
        <tr><td>${t("rv.climb")}</td>${res.map((r) => `<td class="n">${r.climbM === null ? "–" : fmt(r.climbM, 0) + " m"}</td>`).join("")}</tr>
        <tr><td>${t("rv.time")}<br><span class="src">${t(RC.speedKey)}</span></td>${res.map((r) => `<td class="n">${hrs(r.timeM)}</td>`).join("")}</tr>
      </tbody></table></div>
      <section class="section"><h3>${t("rv.lim.t")}</h3><p style="margin:0">${t("rv.lim", { r40: fmt(40, 0), r200: fmt(200, 0) })}</p></section>
      <section class="section"><h3>${t("rv.src.t")}</h3><ul style="margin:0;padding-left:20px;display:grid;gap:4px">
        <li><a href="https://science.nasa.gov/mission/viper/lunar-operations/" target="_blank" rel="noopener">NASA – VIPER lunar operations</a>: ${t("rv.src.1")}</li>
        <li><a href="https://science.nasa.gov/mission/viper/rover-and-instruments" target="_blank" rel="noopener">NASA – VIPER rover and instruments</a>: ${t("rv.src.2")}</li>
        <li><a href="https://www.nasa.gov/feature/jpl/nasas-curiosity-mars-rover-takes-a-new-selfie-before-record-climb" target="_blank" rel="noopener">NASA/JPL – Curiosity record climb (2020)</a>: ${t("rv.src.3")}</li>
        <li><a href="https://www.jpl.nasa.gov/news/nasas-self-driving-perseverance-mars-rover-takes-the-wheel" target="_blank" rel="noopener">NASA/JPL – Perseverance AutoNav (2021)</a>: ${t("rv.src.4")}</li></ul></section>`;
    RV.gls = [];
    out.querySelectorAll("canvas.rv-canvas").forEach((cv) => {
      const i = +cv.dataset.i, T = D_.terrains[i];
      let draw = null; try { draw = glViewer(cv, T, res[i], exag); } catch (e) { draw = null; }
      if (!draw) draw = flatViewer(cv, T, res[i]);
      RV.gls.push(draw);
      let drag = null;
      cv.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); });
      cv.addEventListener("pointermove", (e) => { if (!drag) return;
        RV.cam.yaw += (e.clientX - drag[0]) * 0.01; RV.cam.pitch = Math.max(0.15, Math.min(1.5, RV.cam.pitch + (e.clientY - drag[1]) * 0.01));
        drag = [e.clientX, e.clientY]; RV.gls.forEach((d) => d()); });
      cv.addEventListener("pointerup", () => { drag = null; });
      cv.addEventListener("wheel", (e) => { e.preventDefault(); RV.cam.dist = Math.max(1.4, Math.min(6, RV.cam.dist * (e.deltaY > 0 ? 1.1 : 0.9))); RV.gls.forEach((d) => d()); }, { passive: false });
    });
  }

  // ---------- about view ----------
  const PATCH = '<svg viewBox="0 0 600 600" role="img" aria-label="Mirror Terrain patch (AI-generated): a rover on Mars terrain above the horizon, mirrored below as Earth terrain"><defs><clipPath id="field-a"><circle cx="300" cy="300" r="228"></circle></clipPath><path id="arc-top-a" d="M 54 300 A 246 246 0 0 1 546 300"></path></defs><circle cx="300" cy="300" r="288" fill="#3B0D11" stroke="#E8A25C" stroke-width="6"></circle><circle cx="300" cy="300" r="279" fill="none" stroke="#E8A25C" stroke-width="1.5" stroke-dasharray="2 6" opacity="0.7"></circle><g clip-path="url(#field-a)"><rect x="60" y="60" width="480" height="240" fill="#4A1418"></rect><circle cx="140" cy="130" r="2" fill="#F2C48D"></circle><circle cx="200" cy="96" r="1.5" fill="#F2C48D"></circle><circle cx="250" cy="150" r="1.2" fill="#F2C48D"></circle><circle cx="335" cy="112" r="1.8" fill="#F2C48D"></circle><circle cx="480" cy="180" r="1.4" fill="#F2C48D"></circle><circle cx="110" cy="190" r="1.3" fill="#F2C48D"></circle><circle cx="300" cy="84" r="1.6" fill="#F2C48D"></circle><circle cx="420" cy="142" r="18" fill="#F2C48D"></circle><path d="M60 300 L60 250 L120 215 L170 240 L230 180 L290 235 L340 205 L400 245 L455 195 L520 240 L540 232 L540 300 Z" fill="#B4462A"></path><path d="M60 300 L60 280 Q150 262 230 276 Q320 290 400 270 Q470 256 540 276 L540 300 Z" fill="#E07B39"></path><ellipse cx="440" cy="284" rx="26" ry="4.5" fill="#B4462A"></ellipse><g fill="#3B0D11"><rect x="262" y="252" width="44" height="14" rx="3"></rect><rect x="293" y="236" width="4" height="17"></rect><rect x="288" y="229" width="15" height="8" rx="2"></rect><circle cx="267" cy="271" r="6"></circle><circle cx="284" cy="271" r="6"></circle><circle cx="301" cy="271" r="6"></circle></g><rect x="60" y="300" width="480" height="240" fill="#1E2A5A"></rect><g transform="translate(0 600) scale(1 -1)"><path d="M60 300 L60 250 L120 215 L170 240 L230 180 L290 235 L340 205 L400 245 L455 195 L520 240 L540 232 L540 300 Z" fill="#3B4C8C"></path><path d="M60 300 L60 280 Q150 262 230 276 Q320 290 400 270 Q470 256 540 276 L540 300 Z" fill="#7A5BA8"></path><ellipse cx="440" cy="284" rx="26" ry="4.5" fill="#3B4C8C"></ellipse><g fill="#141A3A"><rect x="262" y="252" width="44" height="14" rx="3"></rect><rect x="293" y="236" width="4" height="17"></rect><rect x="288" y="229" width="15" height="8" rx="2"></rect><circle cx="267" cy="271" r="6"></circle><circle cx="284" cy="271" r="6"></circle><circle cx="301" cy="271" r="6"></circle></g><circle cx="420" cy="142" r="18" fill="#8FA3E0" opacity="0.55"></circle></g><g stroke="#8FA3E0" stroke-width="2" stroke-linecap="round" opacity="0.45"><line x1="120" y1="420" x2="210" y2="420"></line><line x1="250" y1="436" x2="300" y2="436"></line><line x1="350" y1="414" x2="470" y2="414"></line><line x1="180" y1="470" x2="260" y2="470"></line><line x1="330" y1="488" x2="400" y2="488"></line></g><line x1="60" y1="300" x2="540" y2="300" stroke="#F2C48D" stroke-width="3"></line></g><circle cx="300" cy="300" r="230" fill="none" stroke="#E8A25C" stroke-width="5"></circle><text font-family="Oswald, Arial Narrow, sans-serif" font-weight="700" font-size="40" letter-spacing="7" fill="#F2C48D"><textPath href="#arc-top-a" startOffset="50%" text-anchor="middle">MIRROR TERRAIN</textPath></text><path d="M41 288 L44.5 296.5 L53 300 L44.5 303.5 L41 312 L37.5 303.5 L29 300 L37.5 296.5 Z" fill="#F2C48D"></path><path d="M559 288 L562.5 296.5 L571 300 L562.5 303.5 L559 312 L555.5 303.5 L547 300 L555.5 296.5 Z" fill="#F2C48D"></path></svg>';
  function renderAbout() {
    $("#about").innerHTML = `<header><span class="eyebrow">${t("nav.about")}</span><h2>${t("ab.title")}</h2><p class="lede">${t("ab.lede")}</p></header>
      <section class="section patch"><div class="patch-img">${PATCH}<span class="badge">${t("ab.patch.badge")}</span></div>
        <div><h3>${t("ab.patch.t")}</h3><p style="margin:0">${t("ab.patch")}</p></div></section>
      <section class="section"><h3>${t("why.t")}</h3><p style="margin:0">${t("why.p")}</p>
        <ul style="margin:0;padding-left:20px;display:grid;gap:6px">${[1, 2, 3, 4, 5].map((k) => `<li>${t("why." + k)}</li>`).join("")}</ul></section>
      <section class="section"><h3>${t("diff.t")}</h3><p style="margin:0">${t("diff.short")}</p>
        <ol style="margin:0;padding-left:22px;display:grid;gap:8px">${[1, 2, 3, 4, 5, 6, 7, 8].map((k) => `<li>${t("diff." + k, facts())}</li>`).join("")}</ol></section>
      <section class="section"><h3>${t("ab.challenge.t")}</h3><p style="margin:0">${t("ab.challenge")}</p></section>
      <section class="section"><h3>${t("ab.team.t")}</h3><p style="margin:0">${t("ab.team")}</p></section>
      <section class="section ai"><h3>${t("ab.ai.t")}</h3><ul>${[1, 2, 3, 4].map((k) => `<li>${t("ab.ai" + k)}</li>`).join("")}</ul><p class="src" style="margin:8px 0 0">${t("ab.ai.rest")}</p></section>
      <section class="section"><h3>${t("ab.credits.t")}</h3><p style="margin:0">${t("ab.credits")}</p></section>`;
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "rvplay") { rvPlay(); return; }
    if (b.id === "planpdf") { document.body.classList.add("print-plan"); window.print(); return; }
    if (b.dataset.pt) { S.planT = b.dataset.pt; renderPlan(); return; }
    if (b.dataset.pm) { S.planM = b.dataset.pm; renderPlan(); return; }
    if (b.dataset.rt) { RV.target = b.dataset.rt; renderRover(); return; }
    if (b.dataset.rp) { RV.slope = +b.dataset.rp; renderRover(); return; }
    if (b.dataset.l) { S.lang = b.dataset.l; store("lang", S.lang); applyStatic(); if (map) { map.remove(); map = null; } renderView(); }
    else if (b.dataset.t) { S.target = b.dataset.t; renderControls(); renderMap(); renderDetail(); }
    else if (b.dataset.m) { S.mode = b.dataset.m; renderControls(); renderMap(); renderDetail(); }
    else if (b.dataset.ds) { S.marsDs = b.dataset.ds; renderControls(); renderMap(); renderDetail(); }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "rvsl") { RV.slope = +e.target.value; renderRover(); return; }
    const c = e.target; if (c.dataset && c.dataset.ly) { S.layers[c.dataset.ly] = c.checked; renderMap(); }
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("afterprint", () => document.body.classList.remove("print-plan"));

  // ---------- start ----------
  (async function start() {
    const saved = load("lang"), nav = (navigator.language || "en").slice(0, 2);
    S.lang = LANGS.includes(saved) ? saved : (LANGS.includes(nav) ? nav : "en");
    const h1 = $(".brand h1");                        // header logo: the patch, without label, linking to About
    if (h1 && !$(".brand .logo")) h1.insertAdjacentHTML("beforebegin", `<a class="logo" href="#about" aria-label="Mirror Terrain">${
      PATCH.replace(/ role="img" aria-label="[^"]*"/, ' aria-hidden="true" focusable="false"').replace(/field-a/g, "field-h").replace(/arc-top-a/g, "arc-top-h")}</a>`);
    applyStatic();
    try { await loadAll(); }
    catch (e) { $("#loading").textContent = t("err.load"); return; }
    $("#loading").hidden = true;
    route();
  })();
})();
