// Разовая проверка: все id из popup.js есть в popup.html, все ключи L()/tr()/mark() — в i18n.
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const js = read("popup.js");
const html = read("popup.html");
const i18n = read("lib/i18n.js");
const have = new Set([...i18n.matchAll(/^    ([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
const missingIds = [...used].filter((id) => !ids.has(id));
console.log("ids:", ids.size, "used:", used.size, "missing:", missingIds.join(", ") || "none");
const keys = new Set([...js.matchAll(/L\("([^"]+)"/g)].map((m) => m[1]));
console.log("popup keys missing:", [...keys].filter((key) => !have.has(key)).join(", ") || "none");
for (const file of ["lib/miner.js", "lib/kick.js", "lib/kickcases.js", "lib/kickpoints.js"]) {
  const text = read(file);
  const used2 = new Set([...text.matchAll(/(?:tr|mark)\((?:state, )?"([^"]+)"/g)].map((m) => m[1]));
  const miss = [...used2].filter((key) => !have.has(key));
  console.log(file, "missing:", miss.join(", ") || "none");
}
