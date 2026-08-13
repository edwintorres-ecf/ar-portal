'use strict';
// ─── eci-pdf-gen.js — official ECF invoice PDF (rebuilt 2026-08-13) ──────────
// Verbatim to the ECI-025238 sample Edwin supplied: logo + green INVOICE,
// company block, BILL TO / SHIP TO, green reference/terms bar, line-item
// table with subtotal/tax/total, three-column remit footer (US Mail /
// Overnight / ACH-Wire), italic thank-you line. Rendered via the shared
// Chromium htmlToPdf (replaces the June pdfkit layout, which was invented).
// Signature unchanged: generateEciPdf(inv, lines) -> Buffer.

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d) => {
  const dt = new Date(d);
  return isNaN(dt) ? '' : `${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')}/${dt.getFullYear()}`;
};

async function generateEciPdf(inv, lines) {
  const comms = require('./comms-service');

  const items = (lines && lines.length ? lines : [{
    itemId: '', description: inv.description || 'Services Rendered',
    quantity: 1, price: inv.totalEntered, total: inv.totalEntered,
  }]).map(l => ({
    code: l.itemId || '',
    desc: l.description || l.itemName || l.memo || l.deptName || 'Services',
    qty: Number(l.quantity) || 1,
    price: Number(l.price != null ? l.price : l.total) || 0,
    amount: Number(l.total != null ? l.total : l.price) || 0,
  }));
  const subtotal = items.reduce((s, l) => s + l.amount, 0);
  const total = Number(inv.totalEntered) || subtotal;
  const tax = Math.max(0, total - subtotal);

  // Payment terms from the invoice's own dates (30 days -> Net30)
  let terms = '';
  if (inv.whenCreated && inv.whenDue) {
    const days = Math.round((new Date(inv.whenDue) - new Date(inv.whenCreated)) / 86400000);
    if (days > 0) terms = 'Net' + days;
  }

  const logo = comms.ecfLogoUri();
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(inv.invoiceId)}</title>
<style>
  body { font-family: Verdana, Geneva, sans-serif; font-size: 11px; color: #000; margin: 0; padding: 20px 28px; }
  .toprule { border-top: 2px solid #555; margin-bottom: 14px; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; }
  .hdr img { height: 46px; }
  .doc-title { font-size: 44px; font-weight: bold; color: #2EB14B; letter-spacing: 1px; }
  .invmeta { text-align: right; font-size: 11px; margin-top: 6px; }
  .invmeta b { font-weight: bold; }
  .company { margin-top: 22px; font-size: 11px; line-height: 1.5; }
  .parties { display: flex; margin-top: 30px; font-size: 11px; }
  .party { display: flex; gap: 8px; width: 46%; }
  .party .lbl { font-weight: bold; font-size: 9.5px; }
  .party .who { line-height: 1.45; }
  table { width: 100%; border-collapse: collapse; margin-top: 26px; }
  th { background: #8DC63F; background: linear-gradient(#9BCE52, #7DBB35); font-size: 10px; font-weight: bold; padding: 7px 8px; border: 1px solid #1F3864; }
  td { border: 1px solid #1F3864; padding: 6px 8px; font-size: 10.5px; text-align: center; }
  td.desc { text-align: center; }
  td.num { text-align: right; }
  .totals td { border: 1px solid #1F3864; font-weight: bold; }
  .noborder { border: none !important; }
  .remit { display: flex; justify-content: space-between; margin-top: 120px; font-size: 10.5px; text-align: center; line-height: 1.5; }
  .remit .col { flex: 1; }
  .remit b { font-size: 11px; }
  .thanks { text-align: center; font-style: italic; font-size: 11px; margin-top: 40px; }
</style>
</head>
<body>
<div class="toprule"></div>
<div class="hdr">
  <div>${logo ? `<img src="${logo}" alt="East Coast Facilities">` : '<div style="font-size:18px;font-weight:bold">East Coast Facilities</div>'}</div>
  <div>
    <div class="doc-title">INVOICE</div>
    <div class="invmeta">INVOICE #: <b>${esc(inv.invoiceId)}</b><br>DATE: <b>${dmy(inv.whenCreated)}</b></div>
  </div>
</div>

<div class="company">
  749 Roble Rd<br>Suite 2<br>Allentown, PA 18109<br>Phone 844-ECF-CORP<br>ARClerk@eastcoastfacilities.com
</div>

<div class="parties">
  <div class="party">
    <span class="lbl">BILL<br>TO:</span>
    <span class="who"><b>${esc(inv.customerName)}</b>${inv.locationName ? '<br>' + esc(inv.locationName) : ''}</span>
  </div>
  <div class="party">
    <span class="lbl">SHIP<br>TO:</span>
    <span class="who"><b>${esc(inv.siteCode || inv.customerName)}</b>${inv.locationName && !inv.siteCode ? '<br>' + esc(inv.locationName) : ''}</span>
  </div>
</div>

<table>
  <tr><th style="width:27%">REFERENCE #</th><th style="width:33%">ACCOUNTING CONTACT</th><th style="width:17%">PAYMENT TERMS</th><th style="width:23%">DUE DATE</th></tr>
  <tr><td>${esc(inv.poNumber || 'Contract')}</td><td>arclerk@eastcoastfacilities.com</td><td>${esc(terms)}</td><td>${dmy(inv.whenDue)}</td></tr>
</table>

<table>
  <tr><th style="width:10%">ITEM #</th><th style="width:50%">DESCRIPTION</th><th style="width:8%">QTY</th><th style="width:16%">PRICE</th><th style="width:16%">AMOUNT</th></tr>
  ${items.map(l => `<tr>
    <td>${esc(l.code)}</td>
    <td class="desc">${esc(l.desc)}</td>
    <td>${l.qty}</td>
    <td class="num">${money(l.price)}</td>
    <td class="num">${money(l.amount)}</td>
  </tr>`).join('')}
  <tr class="totals"><td class="noborder" colspan="3"></td><td class="num">Subtotal</td><td class="num">${money(subtotal)}</td></tr>
  ${tax > 0.005 ? `<tr class="totals"><td class="noborder" colspan="3"></td><td class="num">Sales Tax</td><td class="num">${money(tax)}</td></tr>` : ''}
  <tr class="totals"><td class="noborder" colspan="3"></td><td class="num">Total</td><td class="num">${money(total)}</td></tr>
</table>

<div class="remit">
  <div class="col">
    <b>US Mail</b><br>East Coast Facilities, Inc.<br>P.O. BOX 855821.<br>Minneapolis MN 55485-5821
  </div>
  <div class="col">
    <b>Remit to:</b><br><b>Overnight Mail</b><br>East Coast Facilities, Inc.<br>LOCKBOX - 855821<br>Wells Fargo Bank<br>1801 Parkview Drive, 1<sup>ST</sup> Floor<br>Shoreview, MN 55126
  </div>
  <div class="col">
    <b>ACH/Wire</b><br>East Coast Facilities, Inc.<br>Wells Fargo Bank N.A.<br>Account Number 4943718155<br>ABA Number 121000248<br>SWIFT Code: WFBIUS6S
  </div>
</div>

<div class="thanks">Thank you for your business, please feel free to contact us at 844-ECF-CORP if you have any questions!</div>
</body>
</html>`;

  return comms.htmlToPdf(html);
}

module.exports = { generateEciPdf };
