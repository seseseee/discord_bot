// scripts/run-retrain-with-rollback.js
const fs = require("fs");
const { spawnSync } = require("child_process");
const p = "data/weights.json";
const bak = "data/weights.json.bak";

const before = fs.readFileSync(p);
const r = spawnSync("npm", ["run", "retrain"], { stdio: "inherit", shell: true });
if (r.status !== 0) {
  console.error("[weekly] retrain failed, rollback weights.json");
  if (fs.existsSync(bak)) fs.copyFileSync(bak, p);
  process.exit(1);
}
console.log("[weekly] retrain ok");
