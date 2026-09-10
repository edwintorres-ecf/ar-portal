const { chromium } = require("playwright-core");
const fs = require("fs");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/chromium-browser", args:["--no-sandbox"] });
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type()==="error") errs.push("console: " + m.text()); });
  const R = (f) => fs.readFileSync("/home/ecf-admin/ar-portal/public/" + f.split("?")[0], "utf8");
  const db = require("/home/ecf-admin/ar-portal/db"); db.getDb();
  const sage = require("/home/ecf-admin/ar-portal/sage");
  const payee = require("/home/ecf-admin/ar-portal/payee");
  const sl = require("/home/ecf-admin/ar-portal/site-ledger");
  const pl = require("/home/ecf-admin/ar-portal/po-ledger");
  const invs = sage.getCachedInvoices();
  const rows = sl.buildAmazonRows(invs, { payee });

  // Reproduce the server's site-contacts payload, including the branch mapping.
  const cmap = db.getSiteContactMap(), master = db.getAmazonLocationMap();
  const tally = {}, invCount = {};
  for (const r of rows) { if (!r.site) continue; invCount[r.site]=(invCount[r.site]||0)+1;
    const t = tally[r.site] = tally[r.site] || {}; const k = r.serviceCenter || ""; if (k) t[k]=(t[k]||0)+1; }
  const scOf = {}; for (const [s,t] of Object.entries(tally)) { const best=Object.entries(t).sort((a,b)=>b[1]-a[1])[0]; if(best) scOf[s]=best[0]; }
  const sites = Object.keys(cmap).sort().map(code => ({
    siteCode: code, serviceCenter: scOf[code] || "", openInvoices: invCount[code] || 0,
    businessUnit: (master[code]||{}).businessUnit || "",
    amazonName: cmap[code].amazon_name, amazonEmail: cmap[code].amazon_email,
    amazonSource: cmap[code].amazon_source, amazonPinned: !!cmap[code].amazon_pinned,
    internalEmail: cmap[code].internal_email, internalPinned: !!cmap[code].internal_pinned, poCount: 1, pos: [],
  }));

  await p.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const j = (o) => route.fulfill({ status:200, contentType:"application/json", body: JSON.stringify(o) });
    if (path === "/") return route.fulfill({ status:200, contentType:"text/html", body: R("index.html") });
    if (path.endsWith(".js")) return route.fulfill({ status:200, contentType:"application/javascript", body: R(path.slice(1)) });
    if (path === "/styles.css") return route.fulfill({ status:200, contentType:"text/css", body: R("styles.css") });
    if (path === "/auth/me") return j({ email:"edwin.torres@eastcoastfacilities.com", name:"Edwin Torres", role:"admin", caps:["*"] });
    if (path === "/api/users") return j(db.listUsers().map(u => ({ email: u.email, name: u.name })));
    if (path === "/api/po/ledger") return j(pl.getPoLedger(invs));
    if (path === "/api/po/needs-upload") return j(pl.getNeedsUpload(invs));
    if (path === "/api/po/meta") return j({ businessUnits: db.getBusinessUnits().map(r => r.bu) });
    if (path === "/api/amazon/site-contacts") return j({ sites });
    if (path === "/api/amazon/rejections") return j({ summary:{}, rows:[] });
    if (path === "/api/po/aging") return j({ buckets:[], totals:{count:0,amount:0}, bands:{} });
    if (path === "/api/po/exceptions") return j({ exceptions:[], duplicates:[], graceHours:72 });
    if (path.startsWith("/api/")) return j([]);
    return route.fulfill({ status:200, contentType:"text/plain", body:"" });
  });
  await p.goto("http://local.test/", { waitUntil:"networkidle" });
  await p.evaluate(() => navGo("po-funds"));
  await p.waitForTimeout(1500);
  await p.evaluate(() => setPoFundsSubtab("contacts"));
  await p.waitForTimeout(1500);
  const byBranch = await p.evaluate(() => {
    const el = document.getElementById("po-contacts-content");
    const cards = [...el.querySelectorAll("div")].filter(d => /Assign all \d+/.test(d.innerText) && d.querySelector("select"));
    return { groupCount: cards.length,
      labels: cards.slice(0,12).map(c => c.innerText.split("\n").slice(0,2).join(" — ")),
      selects: cards.length ? cards[0].querySelectorAll("select option").length : 0 };
  });
  console.log("GROUPED BY BRANCH:", JSON.stringify(byBranch, null, 1));
  const byBu = await p.evaluate(() => { _scGroupBy = "businessUnit"; renderSiteContacts();
    const el = document.getElementById("po-contacts-content");
    return [...el.querySelectorAll("div")].filter(d => /Assign all \d+/.test(d.innerText) && d.querySelector("select")).length; });
  console.log("groups when grouped by business unit:", byBu);
  console.log("JS ERRORS:", errs.length ? errs.slice(0,5) : "none");
  await b.close();
})();
