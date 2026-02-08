import express from "express";
import * as pool from "./pool.js";
import * as db from "./db/pool.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const POOL_API_KEY = process.env.POOL_API_KEY;

const app = express();
app.disable("x-powered-by");
app.use(express.json());

// --- Auth middleware ---
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== POOL_API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  return next();
}

// --- Routes ---

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Pool status overview
app.get("/api/pool/status", requireAuth, async (_req, res) => {
  try {
    const counts = await db.countByStatus();
    const instances = await db.listAll();
    res.json({ counts, instances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim an idle instance and provision it with instructions.
// This is what the webapp calls.
app.post("/api/pool/claim", requireAuth, async (req, res) => {
  const { conciergeId, instructions } = req.body || {};
  if (!instructions || typeof instructions !== "string") {
    return res.status(400).json({ error: "instructions (string) is required" });
  }
  if (!conciergeId || typeof conciergeId !== "string") {
    return res.status(400).json({ error: "conciergeId (string) is required" });
  }

  try {
    const result = await pool.provision(conciergeId, instructions);
    if (!result) {
      return res.status(503).json({
        error: "No idle instances available. Try again in a few minutes.",
      });
    }
    res.json(result);
  } catch (err) {
    console.error("[api] Claim failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Manually trigger a replenish cycle
app.post("/api/pool/replenish", requireAuth, async (_req, res) => {
  try {
    await pool.tick();
    const counts = await db.countByStatus();
    res.json({ ok: true, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Background tick ---
// Poll provisioning instances and replenish every 30 seconds.
const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL_MS || "30000", 10);
setInterval(() => {
  pool.tick().catch((err) => console.error("[tick] Error:", err));
}, TICK_INTERVAL);

// Run initial tick on startup
setTimeout(() => {
  pool.tick().catch((err) => console.error("[tick] Initial tick error:", err));
}, 2000);

app.listen(PORT, () => {
  console.log(`Pool manager listening on :${PORT}`);
});
