import { readFileSync } from 'node:fs';
import { attestCanonicalBaseline } from '/opt/phub/timeweb-beta/standard/source/scripts/timeweb-api-web-upgrade.js';
try {
  console.log(JSON.stringify(attestCanonicalBaseline(JSON.parse(readFileSync('/tmp/bl.json', 'utf8')))));
} catch (e) {
  console.error('ERR', e && e.message);
  process.exit(1);
}
