const { chromium } = require("playwright-core");
const fs = require("fs");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/chromium-browser", args:["--no-sandbox"] });
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type()==="error") errs.push("console: " + m.text()); });
  const R = (f) => fs.readFileSync("/home/ecf-admin/ar-portal/staging/public/" + f, "utf8");
  const db = require("/home/ecf-admin/ar-portal/db"); db.getDb();
  const sage = require("/home/ecf-admin/ar-portal/sage");
  const pl = require("/home/ecf-admin/ar-portal/po-ledger");
  const invs = sage.getCachedInvoices();
  const ledger = pl.getPoLedger(invs), needs = pl.getNeedsUpload(invs);
  const meta = { businessUnits: db.getBusinessUnits().map(r => r.bu), payeeFeed: new Date().toISOString(), openPos: new Date().toISOString(), poDocs: new Date().toISOString(), sageInvoices: new Date().toISOString() };
  await p.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const j = (o) => route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(o) });
    if (path === "/") return route.fulfill({ status:200, contentType:"text/html", body: R("index.html") });
    if (path.endsWith(".js")) return route.fulfill({ status:200, contentType:"application/javascript", body: R(path.slice(1).split("?")[0]) });
    if (path === "/styles.css") return route.fulfill({ status:200, contentType:"text/css", body: R("styles.css") });
    if (path === "/auth/me") return j({ email:"edwin.torres@eastcoastfacilities.com", name:"Edwin Torres", role:"admin", caps:["*"] });
    if (path === "/api/po/ledger") return j(ledger);
    if (path === "/api/po/needs-upload") return j(needs);
    if (path === "/api/po/meta") return j(meta);
    if (path === "/api/health/data") return j({ checks: [{check_key:"x",status:"ok",detail:"",updated_at:"now"}] });
    if (path === "/api/po/aging") return j({ buckets:[], totals:{count:0,amount:0}, bands:{} });
    if (path === "/api/po/exceptions") return j({ exceptions:[], duplicates:[], graceHours:72 });
    if (path === "/api/amazon/rejections") return j({ summary:{open:2,openAmount:100}, rows:[] });
    if (path.startsWith("/api/")) return j([]);
    return route.fulfill({ status:200, contentType:"text/plain", body:"" });
  });
  await p.goto("http://local.test/", { waitUntil:"networkidle" });
  await p.evaluate(() => navGo("po-funds"));
  await p.waitForTimeout(3000);
  const out = await p.evaluate(() => {
    const tabs = [...document.querySelectorAll("#view-po-funds .cust-pill")].map(b => ({ text: b.innerText.trim(), visible: b.offsetParent !== null, right: Math.round(b.getBoundingClientRect().right) }));
    return {
      tabs,
      freshness: (document.getElementById("po-funds-freshness")||{}).innerText || "(EMPTY)",
      buOptions: (window._msReg && _msReg["po-bu"] ? _msReg["po-bu"].options.length : "no picker"),
      containerRight: Math.round(document.querySelector("#view-po-funds > div").getBoundingClientRect().right),
    };
  });
  console.log("freshness:", JSON.stringify(out.freshness).slice(0,160));
  console.log("BU options in picker:", out.buOptions);
  console.log("container right edge:", out.containerRight);
  for (const t of out.tabs) console.log("  tab", JSON.stringify(t.text), "visible", t.visible, "right", t.right, t.right > out.containerRight ? "  <-- OFF THE EDGE" : "");
  console.log("JS ERRORS:", errs.length ? errs.slice(0,5) : "none");
  await b.close();
})();
