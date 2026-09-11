const { chromium } = require("playwright-core");
const fs = require("fs");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/chromium-browser", args:["--no-sandbox"] });
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push("PAGEERROR: " + e.message + "\n   " + String(e.stack || "").split("\n").slice(1,3).join("\n   ")));
  p.on("console", m => { if (m.type()==="error") errs.push("console: " + m.text()); });
  const reqs = [];
  p.on("request", r => { const u = new URL(r.url()).pathname; if (u.startsWith("/api/")) reqs.push(u + (new URL(r.url()).search || "")); });
  const R = (f) => fs.readFileSync("/home/ecf-admin/ar-portal/public/" + f.split("?")[0], "utf8");
  const db = require("/home/ecf-admin/ar-portal/db"); db.getDb();
  const sage = require("/home/ecf-admin/ar-portal/sage");
  const payee = require("/home/ecf-admin/ar-portal/payee");
  const pl = require("/home/ecf-admin/ar-portal/po-ledger");
  const sl = require("/home/ecf-admin/ar-portal/site-ledger");
  const invs = sage.getCachedInvoices();
  const ledger = pl.getPoLedger(invs), needs = pl.getNeedsUpload(invs);
  const sites = pl.getPendingBySite(invs, { snowOnly: false });
  await p.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const j = (o) => route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(o) });
    if (path === "/") return route.fulfill({ status:200, contentType:"text/html", body: R("index.html") });
    if (path.endsWith(".js")) return route.fulfill({ status:200, contentType:"application/javascript", body: R(path.slice(1)) });
    if (path === "/styles.css") return route.fulfill({ status:200, contentType:"text/css", body: R("styles.css") });
    if (path === "/auth/me") return j({ email:"edwin.torres@eastcoastfacilities.com", name:"Edwin Torres", role:"admin", caps:["*"] });
    if (path === "/api/po/ledger") return j(ledger);
    if (path === "/api/po/needs-upload") return j(needs);
    if (path === "/api/po/uploaded") return j(pl.getUploaded(invs));
    if (path === "/api/po/meta") return j({ businessUnits: db.getBusinessUnits().map(r=>r.bu), payeeFeed:new Date().toISOString(), openPos:new Date().toISOString(), poDocs:new Date().toISOString(), sageInvoices:new Date().toISOString() });
    if (path === "/api/po/pending-by-site") {
      const snow = new URL(route.request().url()).searchParams.get("snow") === "1";
      return j({ sites: snow ? pl.getPendingBySite(invs, { snowOnly: true }) : sites,
        statusTotals:[{status:"Scheduled for payment",count:10,amount:1000}], openAr:1000, openArCount:10 });
    }
    if (path === "/api/health/data") return j({ checks: [] });
    if (path === "/api/po/aging") return j({ buckets:[], totals:{count:0,amount:0}, bands:{} });
    if (path === "/api/po/exceptions") return j({ exceptions:[], duplicates:[], graceHours:72 });
    if (path === "/api/amazon/rejections") return j({ summary:{}, rows:[] });
    if (path.startsWith("/api/")) return j([]);
    return route.fulfill({ status:200, contentType:"text/plain", body:"" });
  });
  await p.goto("http://local.test/", { waitUntil:"networkidle" });
  await p.evaluate(() => navGo("po-funds"));
  await p.waitForTimeout(2500);
  // Match the screenshot: Pending by Site with the snow filter on.
  await p.evaluate(() => setPoFundsSubtab("pending-site"));
  await p.waitForTimeout(500);
  await p.evaluate(() => togglePbsSnow());
  await p.waitForTimeout(2500);
  // Bare identifiers: a top-level `let` lives in the global lexical scope, not
  // on `window`, so window._x is always undefined and measuring that way lies.
  const out = await p.evaluate(() => ({
    buOptions: (typeof _poBuOptions !== "undefined") ? _poBuOptions.length : "undef",
    msRegBu: (typeof _msReg !== "undefined" && _msReg["po-bu"]) ? _msReg["po-bu"].options.length : "no picker",
    freshness: ((document.getElementById("po-funds-freshness")||{}).innerText||"(EMPTY)").slice(0,50),
    badges: ["po-uploaded-badge","po-needs-upload-badge","po-aging-badge"].map(id => (document.getElementById(id)||{}).textContent || "(none)"),
    snowOn: (typeof _pbsSnowOnly !== "undefined") ? _pbsSnowOnly : "undef",
    rawNeedsUpload: (typeof _poRaw !== "undefined" && _poRaw.needsUpload) ? _poRaw.needsUpload.length : "undef",
    needsUploadLen: (typeof _poNeedsUpload !== "undefined") ? _poNeedsUpload.length : "undef",
    pendingSitesLen: (typeof _poPendingSites !== "undefined") ? _poPendingSites.length : "undef",
    pendingSummary: ((document.getElementById("po-pending-site-content")||{}).innerText||"").split("\n").filter(x=>/sites/.test(x))[0] || "(none)",
  }));
  console.log(JSON.stringify(out, null, 1));
  console.log("API CALLS:", reqs.join("\n           "));
  console.log("JS ERRORS:", errs.length ? errs.slice(0,4) : "none");
  await b.close();
})();
