const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'assets/analytics.js'), 'utf8');
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

function visit({ url = 'https://teebe.io/', referrer = '', session = storage(), local = storage() } = {}) {
  const requests = [];
  vm.runInNewContext(script, {
    location: new URL(url), document: { referrer }, URL, URLSearchParams,
    sessionStorage: session, localStorage: local,
    Image: class { set src(value) { requests.push(new URL(value)); } }
  });
  return requests;
}

test('a noreferrer directory visit reaches the existing Worker with its source', async () => {
  const [beacon] = visit({ url: 'https://teebe.io/?utm_source=opentoolshub.com' });
  assert.equal(beacon.searchParams.get('r'), 'opentoolshub.com');
  assert.equal(beacon.searchParams.get('v'), '1');
  const workerSource = fs.readFileSync(path.join(root, 'download-worker/src/index.js'), 'utf8');
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'));
  const records = [];
  const response = await worker.fetch(new Request(beacon, { headers: { Referer: 'https://teebe.io/' } }), {
    WEB: { writeDataPoint: point => records.push(point) }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/gif');
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].blobs, ['/', 'opentoolshub.com', '??', 'visit', 'human']);
});

test('recognized directory tags are normalized and take precedence over referrers', () => {
  const domains = ['trackawesomelist.com', 'ripperhe.github.io', 'wangchujiang.com', 'lvruan.com',
    'nuanyue.com', 'opendmg.app', 'stillworks.dev', 'opentoolshub.com'];
  for (const domain of domains) {
    const [beacon] = visit({
      url: 'https://teebe.io/?utm_source=' + encodeURIComponent(' WWW.' + domain.toUpperCase() + ' '),
      referrer: 'https://example.org/article?private=discarded'
    });
    assert.equal(beacon.searchParams.get('r'), domain);
  }
});

test('unknown, empty, malformed, and duplicate tags fall back to the referrer', () => {
  for (const query of ['', '?utm_source=', '?utm_source=unknown', '?utm_source=user%40example.org',
    '?utm_source=https%3A%2F%2Fopentoolshub.com', '?utm_source=opentoolshub.com.evil.test',
    '?utm_source=%E0%A4%A', '?utm_source=opentoolshub.com&utm_source=lvruan.com']) {
    const [beacon] = visit({ url: 'https://teebe.io/' + query, referrer: 'https://example.org/article?private=discarded' });
    assert.equal(beacon.searchParams.get('r'), 'example.org');
  }
});

test('direct visits and malformed referrers remain direct', () => {
  for (const referrer of ['', 'not a URL']) {
    const [beacon] = visit({ url: 'https://teebe.io/?utm_source=unknown', referrer });
    assert.equal(beacon.searchParams.has('r'), false);
  }
});

test('queries, fragments, and arbitrary campaign data are never sent', () => {
  const [beacon] = visit({ url: 'https://teebe.io/guides/codex-worktrees/?utm_source=opentoolshub.com&utm_campaign=private-value&email=person%40example.org#private-fragment' });
  assert.equal(beacon.origin + beacon.pathname, 'https://dl.teebe.io/px');
  assert.equal(beacon.searchParams.get('p'), '/guides/codex-worktrees/');
  assert.deepEqual([...beacon.searchParams.keys()].sort(), ['p', 'r', 't', 'v']);
  assert.doesNotMatch(beacon.href, /private|email|person|utm_campaign/);
});

test('one visit per tab is preserved and campaign sources are not persisted', () => {
  const session = storage();
  const first = visit({ url: 'https://teebe.io/?utm_source=opentoolshub.com', session })[0];
  const second = visit({ url: 'https://teebe.io/privacy/', referrer: 'https://teebe.io/', session })[0];
  assert.equal(first.searchParams.get('v'), '1');
  assert.equal(second.searchParams.get('v'), '0');
  assert.equal(second.searchParams.get('r'), 'teebe.io');
});

test('development exclusion persists across page loads', () => {
  const local = storage();
  const first = visit({ url: 'https://teebe.io/?utm_source=opentoolshub.com&dev=1', local })[0];
  const second = visit({ url: 'https://teebe.io/privacy/', local })[0];
  assert.equal(first.searchParams.get('dev'), '1');
  assert.equal(second.searchParams.get('dev'), '1');
});

test('local previews and other hosts emit no beacon', () => {
  for (const url of ['http://localhost:8000/', 'http://127.0.0.1:8000/', 'file:///tmp/index.html', 'https://example.org/']) {
    assert.deepEqual(visit({ url }), []);
  }
});

test('blocked storage does not interrupt the page or introduce fallback tracking', () => {
  const blocked = { getItem() { throw new Error('Storage disabled'); }, setItem() { throw new Error('Storage disabled'); } };
  assert.deepEqual(visit({ session: blocked }), []);
  assert.deepEqual(visit({ local: blocked }), []);
});

test('all sitemap pages load the shared beacon exactly once', () => {
  const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => new URL(match[1]));
  assert.equal(urls.length, 16);
  for (const url of urls) {
    const html = fs.readFileSync(path.join(root, url.pathname, 'index.html'), 'utf8');
    assert.equal((html.match(/<script src="\/assets\/analytics\.js" defer><\/script>/g) || []).length, 1, url.pathname);
    assert.doesNotMatch(html, /new Image\(\)\.src = 'https:\/\/dl\.teebe\.io\/px'/);
  }
});
