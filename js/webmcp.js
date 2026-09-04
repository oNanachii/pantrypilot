/* PantryPilot — WebMCP registration layer.
   Registers 8 structured tools on document.modelContext (with graceful fallbacks for
   other engine implementations) and mirrors them into the in-page Agent Console so
   the same tool surface can be exercised in any browser.
   Read-only tools carry WebMCP `annotations.readOnlyHint`, per the spec. */

const TOOL_DEFS = [
  {
    name: "get_pantry",
    description: "List every pantry item with quantity, unit, category, expiry date and days left. Call this first to understand kitchen state.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    sampleArgs: {},
    execute: () => Tools.get_pantry()
  },
  {
    name: "add_pantry_items",
    description: "Add one or more items to the pantry (e.g. after grocery shopping). Merges quantities for duplicate names; validates and reports bad rows.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array", description: "Items to add",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Item name, e.g. 'Spinach'" },
              quantity: { type: "number", description: "Amount, must be > 0, default 1" },
              unit: { type: "string", description: "pcs, g, kg, ml, l, pack, bunch" },
              expires_in_days: { type: "number", description: "Days until expiry, clamped to 0-730, default 7" },
              category: { type: "string", description: "Produce, Protein, Dairy, Pantry, Bakery" }
            },
            required: ["name"]
          }
        }
      },
      required: ["items"]
    },
    sampleArgs: { items: [ { name: "Cherry Tomatoes", quantity: 250, unit: "g", expires_in_days: 4 }, { name: "Salmon", quantity: 300, unit: "g", expires_in_days: 2 } ] },
    execute: (input) => Tools.add_pantry_items(input)
  },
  {
    name: "consume_pantry_items",
    description: "Remove or decrement pantry items (after cooking or when they were eaten). Deducts real quantities with g/kg and ml/l conversion; unknown items and unit mismatches are reported, not fatal.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quantity: { type: "number", description: "Amount used; omit to remove the item entirely" },
              unit: { type: "string", description: "Unit of the amount; defaults to the pantry unit" }
            },
            required: ["name"]
          }
        }
      },
      required: ["items"]
    },
    sampleArgs: { items: [ { name: "Spinach", quantity: 150, unit: "g" }, { name: "Parmesan", quantity: 40, unit: "g" } ] },
    execute: (input) => Tools.consume_pantry_items(input)
  },
  {
    name: "find_recipes",
    description: "Search the recipe library by query or ingredients. Ranks recipes that use soon-expiring items, reports missing ingredients, and returns full cooking steps plus per-serving portions for every match.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search over names and ingredients" },
        ingredients: { type: "array", items: { type: "string" }, description: "Treat these as available" },
        max_missing: { type: "number", description: "Max missing ingredients (default 3)" }
      }
    },
    annotations: { readOnlyHint: true },
    sampleArgs: { max_missing: 2 },
    execute: (input) => Tools.find_recipes(input)
  },
  {
    name: "plan_week",
    description: "Generate a dinner plan (default 7 days) that prioritizes items closest to expiry, avoids repeats, and reports which expiring items each day uses up.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to plan, 1-14, default 7" }
      }
    },
    sampleArgs: {},
    execute: (input) => Tools.plan_week(input || {})
  },
  {
    name: "get_plan",
    description: "Read the current dinner plan.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    sampleArgs: {},
    execute: () => Tools.get_plan()
  },
  {
    name: "get_shopping_list",
    description: "Compute everything needed for the planned meals but missing from the pantry, with real amounts, consolidated by supermarket aisle.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    sampleArgs: {},
    execute: () => Tools.get_shopping_list()
  },
  {
    name: "suggest_use_it_up",
    description: "Report items expiring within N days with recipe ideas (including steps) that use them up — the anti-food-waste triage.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "Look-ahead window in days (default 3)" } }
    },
    annotations: { readOnlyHint: true },
    sampleArgs: { days: 3 },
    execute: (input) => Tools.suggest_use_it_up(input || {})
  }
];
window.__PANTRYPILOT_TOOL_DEFS__ = TOOL_DEFS;

/* ---- registration ---- */
(function registerWebMCP() {
  const mcp = document.modelContext || window.modelContext || (navigator.modelContext || null);
  const pill = document.getElementById("mcp-status");
  const registered = [];

  if (mcp && typeof mcp.registerTool === "function") {
    for (const def of TOOL_DEFS) {
      try {
        const tool = {
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
          execute: def.execute
        };
        if (def.annotations) tool.annotations = def.annotations;
        mcp.registerTool(tool);
        registered.push(def.name);
      } catch (err) {
        console.error("WebMCP registerTool failed for " + def.name, err);
      }
    }
  }

  const on = registered.length > 0;
  pill.textContent = on
    ? "● WebMCP: " + registered.length + " tools registered"
    : "● WebMCP: not detected — Agent Console ready";
  pill.classList.toggle("pill-on", on);
  pill.classList.toggle("pill-off", !on);
  pill.title = on
    ? "Registered: " + registered.join(", ")
    : "Open in ChatGPT's in-app browser or Chrome with chrome://flags/#enable-webmcp-testing";
  window.__PANTRYPILOT_REGISTERED__ = registered;
})();

/* ---- in-page agent console (mirrors the real tool surface) ---- */
(function buildConsole() {
  const bar = document.getElementById("console-tools");
  for (const def of TOOL_DEFS) {
    const b = document.createElement("button");
    b.className = "ctool";
    b.textContent = def.name + "()";
    b.title = def.description;
    b.addEventListener("click", async () => {
      let out;
      try {
        out = await def.execute(structuredClone(def.sampleArgs));
        consoleLog("ok", def.name, JSON.stringify(out));
      } catch (err) {
        consoleLog("err", def.name, String(err));
      }
    });
    bar.appendChild(b);
  }
})();
