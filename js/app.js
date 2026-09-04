/* PantryPilot — application state, rendering, and the shared tool implementations.
   The exact same functions back both the WebMCP registrations (webmcp.js) and the
   in-page Agent Console, so judges can exercise the agent surface anywhere. */

/* ---------- state ---------- */
const STORE_KEY = "pantrypilot_v1";
const state = { pantry: [], plan: {}, checked: {}, log: [] };

function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function daysLeft(iso) { return Math.round((new Date(iso) - new Date(todayISO())) / 86400000); }
function canonical(s) { return String(s || "").trim().toLowerCase(); }
function fmtQty(q) {
  const r = Math.round(q * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}
function recipeById(id) { return RECIPE_DB.find(x => x.id === id); }
/* Real per-recipe portions (2 servings): [{ingredient, qty, unit}] */
function recipePortions(recipeId) {
  const r = recipeById(recipeId); if (!r) return [];
  return r.ingredients.map(n => { const p = portionFor(canonical(n)); return { ingredient: canonical(n), qty: p.qty, unit: p.unit }; });
}

/* ---------- state ---------- */
function seed() {
  state.pantry = SEED_PANTRY.map((p, i) => ({
    id: "p" + i, name: p.name, qty: p.qty, unit: p.unit, category: p.category,
    expiry: todayISO(p.shelfDays)
  }));
  save();
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return seed();
    const s = JSON.parse(raw);
    if (!s.pantry) return seed();
    state.pantry = s.pantry; state.plan = s.plan || {}; state.checked = s.checked || {};
  } catch { seed(); }
}

/* ---------- shared tool implementations ---------- */
const Tools = {
  get_pantry() {
    const items = [...state.pantry].sort((a, b) => a.expiry.localeCompare(b.expiry))
      .map(p => ({ name: p.name, quantity: p.qty, unit: p.unit, category: p.category,
                   expires_on: p.expiry, days_left: daysLeft(p.expiry) }));
    return {
      total_items: items.length,
      expiring_within_3_days: items.filter(i => i.days_left <= 3).map(i => i.name),
      items
    };
  },

  add_pantry_items({ items }) {
    const added = [], notes = [];
    for (const it of (items || [])) {
      const raw = String(it.name || "").trim();
      if (!raw) { notes.push("skipped a row with no name"); continue; }
      const name = canonical(raw);
      let qty = Number(it.quantity);
      if (!isFinite(qty) || qty <= 0) { qty = 1; notes.push(name + ": quantity missing/invalid, defaulted to 1"); }
      const unit = it.unit || "pcs";
      let days = Number(it.expires_in_days ?? it.expiresInDays ?? 7);
      if (!isFinite(days)) { days = 7; notes.push(name + ": expiry missing, defaulted to 7 days"); }
      days = Math.max(0, Math.min(730, Math.round(days)));
      const existing = state.pantry.find(p => canonical(p.name) === name && p.unit === unit);
      if (existing) { existing.qty += qty; existing.expiry = todayISO(days); added.push(name + " (merged, now " + fmtQty(existing.qty) + " " + unit + ")"); }
      else {
        state.pantry.push({ id: "p" + Date.now() + Math.random().toString(36).slice(2, 6), name: raw,
          qty, unit, category: it.category || categoryFor(name), expiry: todayISO(days) });
        added.push(name);
      }
    }
    save(); renderAll();
    return { added, pantry_size: state.pantry.length,
      message: "Added " + added.length + " item(s) to the pantry." + (notes.length ? " Notes: " + notes.join("; ") : "") };
  },

  consume_pantry_items({ items }) {
    const consumed = [], missing = [], skipped = [];
    for (const it of (items || [])) {
      const name = canonical(it.name);
      const p = state.pantry.find(x => canonical(x.name) === name);
      if (!p) { missing.push(it.name); continue; }
      const want = (it.quantity === undefined || it.quantity === null)
        ? null : { qty: Number(it.quantity), unit: it.unit || p.unit };
      if (!want) { state.pantry = state.pantry.filter(x => x.id !== p.id); consumed.push(p.name + " (used up)"); continue; }
      if (!isFinite(want.qty) || want.qty <= 0) { skipped.push(p.name + " (invalid quantity)"); continue; }
      const haveBase = toBase(p.qty, p.unit), wantBase = toBase(want.qty, want.unit);
      if (!haveBase || !wantBase || haveBase.unit !== wantBase.unit) {
        skipped.push(p.name + " (unit mismatch: pantry " + p.unit + ", asked " + want.unit + ")");
        continue;
      }
      const left = haveBase.qty - wantBase.qty;
      const backFactor = UNIT_BASE[p.unit][1];
      if (left <= 0.001) { state.pantry = state.pantry.filter(x => x.id !== p.id); consumed.push(p.name + " (used up)"); }
      else { p.qty = Math.round((left / backFactor) * 1000) / 1000; consumed.push(p.name + " (" + fmtQty(p.qty) + " " + p.unit + " left)"); }
    }
    save(); renderAll();
    return { consumed, not_in_pantry: missing, unit_mismatches: skipped, pantry_size: state.pantry.length };
  },

  find_recipes({ query, ingredients, max_missing = 3 } = {}) {
    const have = new Set(state.pantry.map(p => canonical(p.name)));
    if (ingredients) (Array.isArray(ingredients) ? ingredients : [ingredients]).forEach(i => have.add(canonical(i)));
    const q = canonical(query);
    let out = RECIPE_DB.map(r => {
      const ings = r.ingredients.map(canonical);
      const missing = ings.filter(i => !have.has(i));
      const urgentHits = ings.filter(i => {
        const p = state.pantry.find(x => canonical(x.name) === i);
        return p && daysLeft(p.expiry) <= 3;
      });
      return { id: r.id, name: r.name, emoji: r.emoji, minutes: r.minutes,
        cookable_now: missing.length === 0,
        missing_ingredients: missing,
        uses_expiring: urgentHits,
        steps: r.steps,
        portions: recipePortions(r.id).map(p => p.ingredient + ": " + fmtQty(p.qty) + " " + p.unit),
        score: urgentHits.length * 2 - missing.length };
    })
    .filter(r => !q || canonical(r.name).includes(q) || RECIPE_DB.find(x => x.id === r.id).ingredients.some(i => canonical(i).includes(q)))
    .filter(r => r.missing_ingredients.length <= max_missing)
    .sort((a, b) => b.score - a.score || a.minutes - b.minutes);
    return { matches: out.length, recipes: out.slice(0, 12) };
  },

  plan_week({ days = 7 } = {}) {
    days = Math.max(1, Math.min(14, Math.round(Number(days) || 7)));
    const pool = RECIPE_DB.map(r => ({ ...r, ings: r.ingredients.map(canonical) }));
    const urgency = new Map(state.pantry.map(p => [canonical(p.name), daysLeft(p.expiry)]));
    const usedRecently = [];
    const plan = {};
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    for (let d = 0; d < days; d++) {
      const date = todayISO(d);
      let best = null, bestScore = -1e9;
      for (const r of pool) {
        if (usedRecently.slice(-2).includes(r.id)) continue;
        let score = 0;
        const covered = [];
        for (const ing of r.ings) {
          const dl = urgency.get(ing);
          if (dl !== undefined && dl <= 5) { score += (6 - Math.max(dl, 0)) * 3; covered.push(ing); }
        }
        if (covered.length === 0) score -= 4;
        score -= usedRecently.filter(x => x === r.id).length * 10;
        if (score > bestScore) { bestScore = score; best = { r, covered }; }
      }
      if (!best) { best = { r: pool[d % pool.length], covered: [] }; }
      usedRecently.push(best.r.id);
      plan[date] = { recipe_id: best.r.id, name: best.r.name, emoji: best.r.emoji, minutes: best.r.minutes,
        covers_expiring: best.covered, day: dayNames[new Date(date + "T12:00:00").getDay()] };
    }
    state.plan = plan; save(); renderAll();
    const urgentUsed = new Set(Object.values(plan).flatMap(p => p.covers_expiring)).size;
    return {
      days: Object.keys(plan).length,
      expiring_items_covered: urgentUsed,
      summary: Object.entries(plan).map(([date, p]) => p.day + " " + date + ": " + p.name),
      message: "Planned " + days + " dinner(s) prioritizing items that expire soon. Call get_shopping_list for missing ingredients with amounts."
    };
  },

  get_plan() {
    if (!state.plan || Object.keys(state.plan).length === 0)
      return { planned_days: 0, message: "No plan yet — call plan_week or tap 'Auto-plan week'." };
    return { planned_days: Object.keys(state.plan).length, plan: state.plan };
  },

  get_shopping_list() {
    if (!state.plan || Object.keys(state.plan).length === 0)
      return { message: "Plan the week first (plan_week)." };
    const have = new Map(state.pantry.map(p => [canonical(p.name), p]));
    const need = new Map(), willUse = new Set();
    for (const { recipe_id } of Object.values(state.plan)) {
      const r = recipeById(recipe_id); if (!r) continue;
      for (const portion of recipePortions(recipe_id)) {
        const ing = portion.ingredient;
        const p = have.get(ing);
        if (p) { willUse.add(p.name); }
        else if (!need.has(ing)) need.set(ing, { ingredient: ing, amount: portion.qty, unit: portion.unit, aisle: categoryFor(ing), needed_for: 1 });
        else { const e = need.get(ing); e.amount = Math.round((e.amount + portion.qty) * 100) / 100; e.needed_for++; }
      }
    }
    const list = [...need.values()]
      .map(i => ({ ingredient: i.ingredient, amount: fmtQty(i.amount) + " " + i.unit, aisle: i.aisle, needed_for: i.needed_for }))
      .sort((a, b) => a.aisle.localeCompare(b.aisle));
    return {
      items_to_buy: list.length,
      shopping_list: list,
      will_use_from_pantry: [...willUse].sort(),
      message: list.length + " item(s) to buy across " + new Set(list.map(i => i.aisle)).size + " aisles."
    };
  },

  suggest_use_it_up({ days = 3 } = {}) {
    const soon = state.pantry
      .map(p => ({ ...p, days_left: daysLeft(p.expiry) }))
      .filter(p => p.days_left <= days).sort((a, b) => a.days_left - b.days_left);
    const suggestions = soon.map(item => {
      const recipes = RECIPE_DB
        .map(r => ({ name: r.name, emoji: r.emoji, minutes: r.minutes,
          match: r.ingredients.filter(i => canonical(i) === canonical(item.name)).length,
          steps: r.steps,
          extra_missing: r.ingredients.filter(i => !state.pantry.some(p => canonical(p.name) === canonical(i)) && canonical(i) !== canonical(item.name)) }))
        .filter(r => r.match > 0).sort((a, b) => a.extra_missing.length - b.extra_missing.length)
        .slice(0, 3);
      return { item: item.name, expires_on: item.expiry, days_left: item.days_left, quantity: fmtQty(item.qty) + " " + item.unit, recipe_ideas: recipes };
    });
    return { window_days: days, at_risk_items: suggestions.length, suggestions,
      message: suggestions.length ? "Prioritize these before they spoil." : "Nothing expiring soon — nice and fresh." };
  }
};

/* Swap one planned day for the next-best recipe (human control; UI-only). */
function swapDay(date) {
  const cur = state.plan[date];
  if (!cur) return { ok: false, message: "No plan for " + date };
  const inPlan = new Set(Object.values(state.plan).map(p => p.recipe_id));
  const urgency = new Map(state.pantry.map(p => [canonical(p.name), daysLeft(p.expiry)]));
  const score = r => {
    let s = 0;
    for (const ing of r.ingredients.map(canonical)) {
      const dl = urgency.get(ing);
      if (dl !== undefined && dl <= 5) s += (6 - Math.max(dl, 0)) * 3;
    }
    return s - r.minutes / 60;
  };
  let cands = RECIPE_DB.filter(r => r.id !== cur.recipe_id && !inPlan.has(r.id));
  if (!cands.length) cands = RECIPE_DB.filter(r => r.id !== cur.recipe_id);
  cands.sort((a, b) => score(b) - score(a));
  const next = cands[0];
  const covered = next.ingredients.map(canonical).filter(ing => {
    const dl = urgency.get(ing); return dl !== undefined && dl <= 5;
  });
  state.plan[date] = { recipe_id: next.id, name: next.name, emoji: next.emoji, minutes: next.minutes,
    covers_expiring: covered, day: cur.day };
  save(); renderAll();
  return { ok: true, date, from: cur.name, to: next.name };
}

/* Cook a planned meal: deduct real portions from the pantry. */
function cookDay(date) {
  const p = state.plan[date]; if (!p) return null;
  const r = recipeById(p.recipe_id); if (!r) return null;
  const res = Tools.consume_pantry_items({ items: recipePortions(r.id).map(pt => ({ name: pt.ingredient, quantity: pt.qty, unit: pt.unit })) });
  delete state.plan[date]; save(); renderAll();
  return { recipe: r.name, consumed: res.consumed.length, skipped: res.unit_mismatches.length };
}

/* ---------- rendering ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]));

function expColor(dl) { return dl <= 2 ? "var(--red)" : dl <= 5 ? "var(--accent2)" : "var(--green)"; }

function renderPantry() {
  const t = Tools.get_pantry();
  $("#pantry-stats").innerHTML = `
    <div class="stat ok"><b>${t.total_items}</b><span>items tracked</span></div>
    <div class="stat warn"><b>${t.expiring_within_3_days.length}</b><span>expiring ≤ 3 days</span></div>
    <div class="stat"><b>${new Set(state.pantry.map(p => p.category)).size}</b><span>categories</span></div>`;
  $("#pantry-list").innerHTML = t.items.map(p => {
    const dl = p.days_left, pct = Math.max(0, Math.min(100, (dl / 21) * 100));
    const cls = dl <= 3 ? "urgent" : dl > 14 ? "fresh" : "";
    return `<div class="card ${cls}">
      <button class="del" data-del="${esc(p.name)}" title="Remove">✕</button>
      <h4>${esc(p.name)}<span class="qty">${fmtQty(p.quantity)} ${esc(p.unit)}</span></h4>
      <div class="sub">${p.days_left < 0 ? "expired" : dl === 0 ? "expires today" : dl + " days left"} · ${esc(p.category)}</div>
      <div class="exp-bar"><i style="width:${pct}%;background:${expColor(dl)}"></i></div>
      <span class="chip">expires ${p.expires_on}</span>
    </div>`;
  }).join("") || `<p class="hint">Pantry is empty — add items or call <code>add_pantry_items</code>.</p>`;
}

function renderPlan() {
  const dates = Object.keys(state.plan || {}).sort();
  if (!dates.length) {
    $("#plan-grid").innerHTML = `<p class="hint">Nothing planned yet — tap ✨ Auto-plan week, or ask your agent to call <code>plan_week</code>.</p>`;
    $("#plan-meta").textContent = "";
    return;
  }
  $("#plan-grid").innerHTML = dates.map(d => {
    const p = state.plan[d];
    return `<div class="day-card">
      <div class="dow">${esc(p.day)} · ${d.slice(5)}</div>
      <h4>${p.emoji} ${esc(p.name)}</h4>
      <div class="sub">~${p.minutes} min · serves 2</div>
      ${p.covers_expiring.length ? `<div class="uses">♻️ uses up: ${p.covers_expiring.map(esc).join(", ")}</div>` : `<div class="uses">—</div>`}
      <div class="day-actions">
        <button class="btn btn-sm" data-swap="${d}">🔀 Swap</button>
        <button class="btn btn-sm cook-btn" data-cook="${d}">✅ Cooked it (update pantry)</button>
      </div>
    </div>`;
  }).join("");
  const covered = new Set(Object.values(state.plan || {}).flatMap(p => p.covers_expiring)).size;
  $("#plan-meta").textContent = `${dates.length} day(s) planned · ${covered} expiring items put to use`;
}

function renderShopping() {
  const res = Tools.get_shopping_list();
  if (res.message && !res.shopping_list) { $("#shopping-list").innerHTML = `<p class="hint">${esc(res.message)}</p>`; $("#shopping-meta").textContent = ""; return; }
  const byAisle = {};
  res.shopping_list.forEach(i => { (byAisle[i.aisle] = byAisle[i.aisle] || []).push(i); });
  $("#shopping-list").innerHTML = Object.entries(byAisle).map(([aisle, items]) => `
    <div class="aisle"><h4>${esc(aisle)}</h4>${items.map(i => `
      <label><input type="checkbox" data-check="${esc(i.ingredient)}" ${state.checked[i.ingredient] ? "checked" : ""}>
      ${esc(i.ingredient)} <b>${esc(i.amount)}</b> <span class="hint">(for ${i.needed_for} meal${i.needed_for > 1 ? "s" : ""})</span></label>`).join("")}
    </div>`).join("") +
    (res.will_use_from_pantry.length ? `<div class="aisle" style="grid-column:1/-1"><h4>♻️ Will use from pantry (${res.will_use_from_pantry.length})</h4><div class="hint">${res.will_use_from_pantry.map(esc).join(" · ")}</div></div>` : "");
  $("#shopping-meta").textContent = `${res.items_to_buy} items to buy`;
}

function renderRecipes() {
  const q = canonical($("#recipe-search").value);
  const res = Tools.find_recipes({ query: q || undefined, max_missing: 6 });
  $("#recipe-list").innerHTML = res.recipes.map(r => {
    const real = recipeById(r.id);
    return `
    <div class="card recipe-card ${r.cookable_now ? "cookable" : ""}">
      <h4 class="rc-head" data-recipe="${r.id}" style="cursor:pointer">${r.emoji} ${esc(r.name)}<span class="qty">${r.minutes}′ ${r.cookable_now ? "· ✓" : ""}</span></h4>
      ${r.cookable_now ? `<span class="chip" style="color:var(--green)">✓ cookable now</span>` :
        `<div class="missing">missing: ${r.missing_ingredients.map(esc).join(", ")}</div>`}
      ${r.uses_expiring.length ? `<span class="chip" style="color:var(--accent2)">♻️ uses ${r.uses_expiring.map(esc).join(", ")}</span>` : ""}
      <div class="rc-detail hidden" id="rc-${r.id}">
        <div class="sub" style="margin:.5rem 0 .2rem"><b>Portions (2 servings):</b> ${real.ingredients.map(n => { const p = portionFor(canonical(n)); return esc(n) + " " + fmtQty(p.qty) + p.unit; }).join(" · ")}</div>
        <ol class="steps">${real.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
      </div>
    </div>`;
  }).join("") || `<p class="hint">No matches.</p>`;
}

function renderAbout() {
  const defs = window.__PANTRYPILOT_TOOL_DEFS__ || [];
  $("#tool-list").innerHTML = defs.map(d => `<li><b>${d.name}</b> — ${esc(d.description)}</li>`).join("");
  $("#code-sample").textContent = `document.modelContext.registerTool({
  name: "plan_week",
  description: "Plan dinners around what is expiring first",
  inputSchema: { type: "object",
    properties: { days: { type: "number" } } },
  annotations: { readOnlyHint: false },
  execute: async (input) => Tools.plan_week(input)
});`;
}

function renderAll() { renderPantry(); renderPlan(); renderShopping(); renderRecipes(); }

/* ---------- events ---------- */
function wire() {
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    $("#tab-" + t.dataset.tab).classList.add("active");
  }));

  $("#pantry-form").addEventListener("submit", e => {
    e.preventDefault();
    Tools.add_pantry_items({ items: [{ name: $("#f-name").value, quantity: Number($("#f-qty").value),
      unit: $("#f-unit").value, expires_in_days: Number($("#f-days").value) }] });
    $("#f-name").value = ""; $("#f-name").focus();
  });

  $("#pantry-list").addEventListener("click", e => {
    const del = e.target.dataset.del;
    if (del) { Tools.consume_pantry_items({ items: [{ name: del }] }); }
  });

  $("#btn-plan-week").addEventListener("click", () => { Tools.plan_week(); switchTo("plan"); });
  $("#btn-clear-plan").addEventListener("click", () => { state.plan = {}; save(); renderAll(); });
  $("#btn-rebuild-list").addEventListener("click", () => { renderShopping(); });

  $("#plan-grid").addEventListener("click", e => {
    const sw = e.target.dataset.swap;
    if (sw) {
      const res = swapDay(sw);
      if (res.ok) consoleLog("ui", null, "Swapped " + res.date + ": " + res.from + " → " + res.to);
      return;
    }
    const d = e.target.dataset.cook;
    if (!d) return;
    const res = cookDay(d);
    if (res) consoleLog("ui", null, "Cooked \"" + res.recipe + "\" — pantry updated (" + res.consumed + " deducted, " + res.skipped + " unit mismatches)");
  });

  $("#recipe-list").addEventListener("click", e => {
    const head = e.target.closest ? e.target.closest("[data-recipe]") : null;
    if (!head) return;
    const box = document.getElementById("rc-" + head.dataset.recipe);
    if (box) box.classList.toggle("hidden");
  });

  $("#shopping-list").addEventListener("change", e => {
    const ing = e.target.dataset.check; if (!ing) return;
    state.checked[ing] = e.target.checked; save();
  });

  $("#recipe-search").addEventListener("input", renderRecipes);

  $("#btn-agent").addEventListener("click", () => $("#agent-console").classList.toggle("hidden"));
  $("#btn-console-close").addEventListener("click", () => $("#agent-console").classList.add("hidden"));

  window.addEventListener("keydown", e => { if (e.key === "Escape") $("#agent-console").classList.add("hidden"); });
}

function switchTo(tab) {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x.dataset.tab === tab));
  document.querySelectorAll(".panel").forEach(x => x.classList.toggle("active", x.id === "tab-" + tab));
}

function consoleLog(kind, tool, detail) {
  const box = $("#console-log");
  const line = document.createElement("div");
  line.className = "log-line " + (kind === "ok" || kind === "err" ? kind : "");
  if (kind === "ui") { line.textContent = detail; }
  else {
    const summary = detail && detail.length > 160 ? detail.slice(0, 160) + "…" : detail;
    line.innerHTML = `<span class="tn">${esc(tool)}</span>() → ${esc(summary)}`;
  }
  box.prepend(line);
  while (box.children.length > 40) box.lastChild.remove();
}

/* ---------- boot ---------- */
load();
wire();
renderAll();
renderAbout();
$("#foot-state").textContent = new Date().getFullYear() + " · " + state.pantry.length + " pantry items · local-first";
