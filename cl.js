const sage = require('/home/ecf-admin/ar-portal/sage.js');
sage.getInvoicesByIds(['ECI-025300']).then(r => console.log('closed lookup:', JSON.stringify(r[0] || null)));
