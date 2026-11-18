import {
  collectDueEntries,
  dueReport,
  formatDueReport,
  readDueSources,
} from '@noctcore/harness/ci';

// Your ledgers: JSON objects whose entries carry a `reviewBy` date.
const LEDGERS = ['overrides.ledger.json', 'licenses.ledger.json'];

const sources = readDueSources(process.cwd(), LEDGERS, '.trivyignore.yaml');
const collection = collectDueEntries(sources);
const today = new Date().toISOString().slice(0, 10);
const report = dueReport(collection, today);
console.log(formatDueReport(report, collection.entries.length).join('\n'));
process.exit(report.passed ? 0 : 1);
