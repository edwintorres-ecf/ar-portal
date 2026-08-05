'use strict';
/**
 * generateEciPdf(inv, lines) → Buffer (PDF)
 * Renders an ECI- invoice as an ECF-branded PDF using pdfkit.
 */

const PDFDocument = require('pdfkit');

const ECF_NAVY   = '#1a2744';
const ECF_GRAY   = '#4a5568';
const ECF_LIGHT  = '#e2e8f0';
const ECF_ORANGE = '#e65c00';
const ECF_ROW_ALT = '#f7fafc';

const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
};

async function generateEciPdf(inv, lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER', margin: 50,
      info: { Title: inv.invoiceId, Author: 'East Coast Facilities Inc.' }
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ML = 50;
    const MR = 50;
    const PW = doc.page.width;   // 612
    const W  = PW - ML - MR;    // 512

    // ─── HEADER BANNER ───────────────────────────────────────────────────────
    doc.rect(ML, 40, W, 70).fill(ECF_NAVY);

    doc.fillColor('white').font('Helvetica-Bold').fontSize(20)
       .text('EAST COAST FACILITIES INC.', ML + 14, 52, { width: 300, lineBreak: false });
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(8.5)
       .text('Facilities Management & Janitorial Services', ML + 14, 76, { width: 300, lineBreak: false });

    // Right: INVOICE label
    doc.fillColor('white').font('Helvetica-Bold').fontSize(20)
       .text('INVOICE', ML + W - 98, 52, { width: 98, align: 'right', lineBreak: false });
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(8.5)
       .text(inv.invoiceId || '', ML + W - 98, 76, { width: 98, align: 'right', lineBreak: false });

    // ─── BILL TO / DETAILS ───────────────────────────────────────────────────
    let y = 128;
    const halfW = 240;
    const rightX = ML + W - 220;

    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ECF_NAVY)
       .text('BILL TO', ML, y);
    y += 12;
    doc.font('Helvetica').fontSize(9).fillColor(ECF_GRAY)
       .text(inv.customerName || inv.customerId || '', ML, y, { width: halfW, lineBreak: false });
    y += 13;
    if (inv.locationName) {
      doc.font('Helvetica').fontSize(8.5).fillColor(ECF_GRAY)
         .text(inv.locationName, ML, y, { width: halfW, lineBreak: false });
      y += 13;
    }

    // Right details
    const detailRows = [
      ['Invoice #:',    inv.invoiceId || ''],
      ['Invoice Date:', fmtDate(inv.whenCreated)],
      ['Due Date:',     fmtDate(inv.whenDue)],
      ['Customer ID:',  inv.customerId || ''],
    ];
    if (inv.poNumber) detailRows.push(['PO Number:', inv.poNumber]);

    let dy = 128;
    for (const [label, val] of detailRows) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(ECF_NAVY)
         .text(label, rightX, dy, { width: 78, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(ECF_GRAY)
         .text(val, rightX + 80, dy, { width: 140, align: 'right', lineBreak: false });
      dy += 13;
    }

    y = Math.max(y, dy) + 18;

    // ─── TABLE ───────────────────────────────────────────────────────────────
    // Columns: Description (left, wide) | Item Code (center) | Amount (right, fixed)
    const COL_AMOUNT_W = 88;
    const COL_ITEM_W   = 100;
    const COL_DESC_W   = W - COL_ITEM_W - COL_AMOUNT_W - 2;

    const colX = {
      desc:   ML,
      item:   ML + COL_DESC_W + 1,
      amount: ML + COL_DESC_W + COL_ITEM_W + 2,
    };

    const drawHeader = (yh) => {
      doc.rect(ML, yh, W, 18).fill(ECF_NAVY);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('white')
         .text('Description', colX.desc + 4, yh + 5, { width: COL_DESC_W - 8, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8).fillColor('white')
         .text('Item Code', colX.item + 4, yh + 5, { width: COL_ITEM_W - 8, align: 'center', lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8).fillColor('white')
         .text('Amount', colX.amount, yh + 5, { width: COL_AMOUNT_W - 4, align: 'right', lineBreak: false });
      return yh + 18;
    };
    y = drawHeader(y);

    const rowLines = (lines && lines.length > 0) ? lines : [{
      itemId: '',
      description: inv.description || 'Services Rendered',
      total: inv.totalEntered || inv.totalDue || 0,
    }];

    let subtotal = 0;
    for (let idx = 0; idx < rowLines.length; idx++) {
      const l = rowLines[idx];
      const desc   = l.description || l.itemName || l.deptName || 'Miscellaneous';
      const code   = l.itemId || '';
      const amount = Number(l.total || l.price || 0);
      subtotal += amount;

      const rowH = 18;
      if (y + rowH > doc.page.height - 130) {
        doc.addPage();
        y = 50;
        y = drawHeader(y);
      }

      const fill = idx % 2 === 0 ? ECF_ROW_ALT : 'white';
      doc.rect(ML, y, W, rowH).fill(fill).stroke(ECF_LIGHT);

      doc.font('Helvetica').fontSize(8.5).fillColor(ECF_GRAY)
         .text(desc, colX.desc + 4, y + 5, { width: COL_DESC_W - 8, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(8.5).fillColor(ECF_GRAY)
         .text(code, colX.item + 4, y + 5, { width: COL_ITEM_W - 8, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(8.5).fillColor(ECF_GRAY)
         .text(fmt(amount), colX.amount, y + 5, { width: COL_AMOUNT_W - 4, align: 'right', lineBreak: false });
      y += rowH;
    }

    doc.moveTo(ML, y).lineTo(ML + W, y).strokeColor(ECF_LIGHT).lineWidth(0.5).stroke();
    y += 10;

    // ─── TOTALS ───────────────────────────────────────────────────────────────
    const totLX = ML + W - 230;
    const totVX = ML + W - 92;
    const totVW = 92;

    const addRow = (label, val, bold) => {
      if (y + 14 > doc.page.height - 110) { doc.addPage(); y = 50; }
      const fn = bold ? 'Helvetica-Bold' : 'Helvetica';
      doc.font(fn).fontSize(bold ? 9 : 8.5).fillColor(ECF_GRAY)
         .text(label, totLX, y, { width: 138, lineBreak: false });
      doc.font(fn).fontSize(bold ? 9 : 8.5).fillColor(ECF_GRAY)
         .text(val, totVX, y, { width: totVW, align: 'right', lineBreak: false });
      y += 14;
    };

    addRow('Subtotal:', fmt(subtotal));
    const paid = subtotal - (inv.totalDue || 0);
    if (paid > 0.005) addRow('Payments Applied:', '(' + fmt(paid) + ')');

    doc.moveTo(totLX, y).lineTo(ML + W, y).strokeColor(ECF_LIGHT).lineWidth(0.5).stroke();
    y += 5;

    const dueAmt = inv.totalDue || subtotal;
    doc.rect(totLX - 6, y - 2, (ML + W) - totLX + 6, 24).fill(ECF_NAVY);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('white')
       .text('AMOUNT DUE:', totLX, y + 4, { width: 138, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('white')
       .text(fmt(dueAmt), totVX, y + 4, { width: totVW, align: 'right', lineBreak: false });
    y += 30;

    // ─── AGING BADGE ─────────────────────────────────────────────────────────
    if (inv.bucket) {
      const isOverdue = inv.bucket === '91+';
      doc.roundedRect(ML, y, 140, 20, 4).fill(isOverdue ? ECF_ORANGE : ECF_NAVY);
      const label = inv.daysOverdue != null ? `${inv.daysOverdue} days overdue` : `Aging: ${inv.bucket}`;
      doc.font('Helvetica-Bold').fontSize(8).fillColor('white')
         .text(label, ML + 8, y + 6, { width: 124, lineBreak: false });
      y += 28;
    }

    // ─── FOOTER ──────────────────────────────────────────────────────────────
    const footY = doc.page.height - 52;
    doc.rect(ML, footY, W, 0.5).fill(ECF_LIGHT);
    doc.font('Helvetica').fontSize(7.5).fillColor(ECF_GRAY)
       .text('East Coast Facilities Inc.  •  Please remit payment by due date.  •  Contact your account representative with questions.',
             ML, footY + 8, { width: W, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
       .text(`${inv.invoiceId}  •  Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })}`,
             ML, footY + 22, { width: W, align: 'center', lineBreak: false });

    doc.end();
  });
}

module.exports = { generateEciPdf };
