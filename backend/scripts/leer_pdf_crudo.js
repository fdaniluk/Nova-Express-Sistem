const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const PDF_PATH = path.join(__dirname, '../../facturas-ejemplo/factura_test_ups.pdf');

async function main() {
  const buffer = fs.readFileSync(PDF_PATH);
  const data = await pdfParse(buffer);

  console.log('='.repeat(60));
  console.log(`TOTAL PÁGINAS: ${data.numpages}`);
  console.log(`TOTAL CARACTERES: ${data.text.length}`);
  console.log('='.repeat(60));
  console.log('\n--- TEXTO CRUDO COMPLETO ---\n');
  console.log(data.text);
  console.log('\n--- FIN DEL TEXTO ---');
}

main().catch(console.error);
