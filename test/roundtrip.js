/* Round-trip test. Put PowerScribe .rtf templates in test/samples/ and run:
     node test/roundtrip.js
   Sample templates are gitignored on purpose — do not commit real ones. */
const fs = require('fs'), path = require('path');
const C = require('../src/core.js');
const dir = path.join(__dirname, 'samples');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.rtf')) : [];
if (!files.length) { console.log('No samples in test/samples/ — nothing to check.'); process.exit(0); }
let fail = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'latin1');
  const doc = C.parseTemplate(src);
  const out = C.serializeTemplate(doc);
  const doc2 = C.parseTemplate(out);
  const unplaced = doc.fields.filter(x => !x.located).map(x => x.name);
  const offsets = C.selfCheck(out);
  const gx = s => s.slice(s.indexOf('<?xml'));
  const checks = {
    'all fields located': unplaced.length === 0,
    'plain text unchanged': doc.plain === doc2.plain,
    'offsets verify': offsets.length === 0,
    'autotext XML byte-identical': gx(src) === gx(out)
  };
  console.log('==', f);
  for (const k in checks) { console.log(' ', checks[k] ? 'PASS' : 'FAIL', k); if (!checks[k]) fail++; }
  if (unplaced.length) console.log('   unplaced:', unplaced);
  if (offsets.length) console.log('   offsets:', offsets.slice(0, 3));
}
process.exit(fail ? 1 : 0);
