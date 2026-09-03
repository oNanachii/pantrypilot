/* PantryPilot — WebMCP registration layer.
   Registers 8 structured tools on document.modelContext (with graceful fallbacks for
   other engine implementations) and mirrors them into the in-page Agent Console so
   the same tool surface can be exercised in any browser. */

const TOOL_DEFS = [
  {
    name: "get_pantry",
    description: "List every pantry item with quantity, unit, category, expiry date and days left. Call this first to understand kitchen state.",
    inputSchema: { type: "object", properties: {} },
    sampleArgs: {},
    execute: () => Tools.get_pantry()
  },
  {
    name: "add_pantry_items",
    description: "Add one or more items to the pantry (e.g. after grocery shopping). Merges quantities for duplicate names.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array", description: "Items to add",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Item name, e.g. 'Spinach'" },
              quantity: { type: "number", description: "Amount, default 1" },
              unit: { type: "string", description: "pcs, g, kg, ml, l, pack, bunch" },
              expires_in_days: { type: "number", description: "Days until expiry, default 7" },
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
    description: "Remove or decrement pantry items (after cooking or when they were eaten). Unknown items are reported, not fatal.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              quantity: { type: "number", description: "Amount used; omit to remove the item entirely" }
            },
            required: ["name"]
          }
        }
      },
      required: ["items"]
    },
    sampleArgs: { items: [ { name: "Spinach", quantity: 200 }, { name: "Parmesan", quantity: 30 } ] },
    execute: (input) => Tools.consume_pantry_items(input)
  },
  {
    name: "find_recipes",
    description: "Search the recipe library by query or ingredients. Ranks recipes that use soon-expiring items and reports missing ingredients.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search over names and ingredients" },
        ingredients: { type: "array", items: { type: "string" }, description: "Treat these as available" },
        max_missing: { type: "number", description: "Max missing ingredients (default 3)" }
      }
    },
    sampleArgs: { max_missing: 2 },
    execute: (input) => Tools.find_recipes(input)
  },
  {
    name: "plan_week",
    description: "Generate a 7-day dinner plan that prioritizes items closest to expiry, avoids repeats, and reports which expiring items each day uses up.",
    inputSchema: { type: "object", properties: {} },
    sampleArgs: {},
    execute: () => Tools.plan_week()
  },
  {
    name: "get_plan",
    description: "Read the current week dinner plan.",
    inputSchema: { type: "object", properties: {} },
    sampleArgs: {},
    execute: () => Tools.get_plan()
  },
  {
    name: "get_shopping_list",
    description: "Compute everything needed for the planned week but missing from the pantry, consolidated by supermarket aisle.",
    inputSchema: { type: "object", properties: {} },
    sampleArgs: {},
    execute: () => Tools.get_shopping_list()
  },
  {
    name: "suggest_use_it_up",
    description: "Report items expiring within N days with recipe ideas that use them up — the anti-food-waste triage.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "Look-ahead window in days (default 3)" } }
    },
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
        mcp.registerTool({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema,
          execute: def.execute
        });
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
