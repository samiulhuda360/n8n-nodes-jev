// Takes the README screenshots and the demo GIF from a running n8n editor (node scripts/n8n-start.mjs).
//
//   DOCS_KIT=<folder with gif.mjs> node scripts/screenshots.mjs
//
// For each example workflow it opens the editor, runs the workflow from its manual trigger against the real Jev
// API, and saves the canvas. It also saves the Jev Decision settings and output, the node in the node picker,
// and records docs/demo.gif of the support inbox run.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'docs', 'screenshots');
const N8N = process.env.N8N_URL || 'http://localhost:5691';
const kit = process.env.DOCS_KIT || 'D:/Portfolio/tools/docs-kit';
const { launch, GifRecorder, clickVisibly } = await import(pathToFileURL(join(kit, 'gif.mjs')).href);
const OWNER = { email: 'ops.lead@example.com', firstName: 'Alex', lastName: 'Morgan', password: 'Demo-Pass-2026' };
const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);
mkdirSync(OUT, { recursive: true });

let { browser, page } = await launch({ width: 1600, height: 900, scale: 1 });

async function dismissPopups() {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(150);
  }
  for (const text of ['Skip', 'Get started', 'Close', 'Dismiss', 'Got it']) {
    const b = page.getByRole('button', { name: text, exact: true });
    if (await b.count()) await b.first().click().catch(() => {});
  }
}

async function signIn() {
  await page.goto(`${N8N}/`);
  await page.waitForTimeout(4000);
  if (page.url().includes('/setup')) {
    for (const [name, value] of Object.entries(OWNER)) await page.fill(`input[name="${name}"]`, value);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForTimeout(4000);
  }
  if (page.url().includes('/signin')) {
    await page.fill('input[name="emailOrLdapLoginId"], input[name="email"]', OWNER.email);
    await page.fill('input[name="password"]', OWNER.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForTimeout(4000);
  }
  await dismissPopups();
}

async function fitView() {
  const fit = page.locator('[data-test-id="zoom-to-fit"]');
  if (await fit.count()) await fit.first().click();
  else await page.keyboard.press('1');
  await page.waitForTimeout(700);
}

async function openWorkflow(slug) {
  const wf = JSON.parse(readFileSync(join(root, 'workflows', `${slug}.json`), 'utf8'));
  await page.goto(`${N8N}/workflow/${wf.id}`);
  try {
    await page.waitForSelector('[data-test-id="canvas-node"]', { timeout: 30000 }).catch(async () => {
      // A freshly started n8n can miss the first load; one reload settles it.
      await page.reload();
      await page.waitForSelector('[data-test-id="canvas-node"]', { timeout: 60000 });
    });
  } catch (error) {
    await page.screenshot({ path: join(root, '.n8n-test', `failed-${slug}.png`) });
    console.log('url', page.url());
    throw error;
  }
  await page.waitForTimeout(1500);
  await dismissPopups();
  await fitView();
}

async function waitForRun() {
  const deadline = Date.now() + 120000;
  await page.waitForTimeout(2500);
  while (Date.now() < deadline) {
    if (!(await page.locator('[data-test-id="stop-execution-button"]').count())) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
}

async function run(visible = false) {
  const button = page.locator('[data-test-id="execute-workflow-button-Try with sample data"]');
  const trigger = page.locator('[data-test-id="canvas-node"][data-node-name="Try with sample data"]');
  await trigger.first().hover();
  await page.waitForTimeout(300);
  if (visible) await clickVisibly(page, button.first());
  else await button.first().click({ force: true });
  await waitForRun();
}

async function openJevNode() {
  await page.locator('[data-test-id="canvas-node"][data-node-name="Jev Decision"]').first().dblclick();
  await page.waitForSelector('[data-test-id="output-panel"]', { timeout: 15000 });
  await page.waitForTimeout(1200);
}

async function chooseView(name) {
  const tab = page.locator(`[data-test-id="output-panel"] [data-test-id="radio-button-${name}"]`);
  if (await tab.count()) await tab.first().click().catch(() => {});
  await page.waitForTimeout(600);
}

await signIn();
// The scripted pointer is for the GIF; still pictures do not need it.
const hideCursor = () => page.addStyleTag({ content: '#__cursor { display: none !important; }' }).catch(() => {});

for (const slug of ['support-inbox-routing', 'incident-triage', 'lead-scoring']) {
  if (!want(slug)) continue;
  console.log('workflow', slug);
  await openWorkflow(slug);
  await hideCursor();
  await run();
  await dismissPopups();
  await fitView();
  await page.screenshot({ path: join(OUT, `${slug}-canvas.png`) });
  if (slug === 'support-inbox-routing') {
    await openJevNode();
    await chooseView('table');
    await page.screenshot({ path: join(OUT, 'jev-node-settings.png') });
    await page.locator('[data-test-id="output-panel"]').getByText('Needs review', { exact: false }).first().click();
    await chooseView('json');
    await page.locator('[data-test-id="output-panel"]').first().screenshot({ path: join(OUT, 'jev-node-output.png') });
    await page.keyboard.press('Escape');
  }
}

if (want('picker')) {
  await openWorkflow('support-inbox-routing');
  await hideCursor();
  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);
  await page.keyboard.type('Jev', { delay: 80 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter'); // opens the node's list of operations
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'node-picker.png') });
  await page.keyboard.press('Escape');
}

if (want('gif')) {
  // A smaller window keeps the GIF light.
  await browser.close();
  ({ browser, page } = await launch({ width: 1280, height: 720, scale: 1 }));
  await signIn();
  await openWorkflow('support-inbox-routing');
  const rec = new GifRecorder(page, { fps: 5, maxWidth: 1280 });
  rec.start();
  await rec.hold(1200);
  await run(true);
  await rec.hold(1500);
  await clickVisibly(page, page.locator('[data-test-id="canvas-node"][data-node-name="Jev Decision"]').first());
  await page.locator('[data-test-id="canvas-node"][data-node-name="Jev Decision"]').first().dblclick();
  await page.waitForSelector('[data-test-id="output-panel"]', { timeout: 15000 });
  await chooseView('table');
  await rec.hold(3000);
  const reviewBranch = page.locator('[data-test-id="output-panel"]').getByText('Needs review', { exact: false });
  if (await reviewBranch.count()) {
    await clickVisibly(page, reviewBranch.first());
    await rec.hold(3000);
  }
  await page.keyboard.press('Escape');
  await rec.hold(1500);
  await rec.stop();
  console.log('gif', rec.save(join(root, 'docs', 'demo.gif'), { dumpDir: join(root, '.n8n-test', 'gif-frames') }));
}

await browser.close();
console.log('saved to', OUT);
