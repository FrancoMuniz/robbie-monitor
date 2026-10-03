import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

// Watches the Robbie Williams show page and pings Telegram when a watched date stops being "Agotado".
// The page is Blazor Server: dates and availability only arrive over its websocket after load,
// so we need a real (headless) browser and a fresh load per check.

const SHOW_URL = 'https://www.movistararena.com.ar/show/944eccdf-8753-4ecd-ac5c-e9189b7fc07e';
// Matches the "day month" text in each date row. Other dates still show in the status message.
const WATCHED_DATES = ['04 Octubre'];
const INTERVAL_MS = 15_000;
const JITTER_MS = 2_000;
const FAILURES_BEFORE_ALERT = 3;
// GitHub Actions kills jobs at 6h, so the workflow sets this to exit cleanly and hand off to the
// next queued run. Unset locally, where it runs until stopped.
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MINUTES || 0) * 60_000;
const STATUS_PREFIX = '👀';

const TOKEN = process.env.TELEGRAM_TOKEN;
// Comma-separated: private chats and/or channels where the bot is an admin that can post and edit.
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean);

// Node's es-AR locale defaults to a 12h clock with no a.m./p.m., so force 24h.
const TIME_FORMAT = { timeZone: 'America/Argentina/Buenos_Aires', hourCycle: 'h23' };
const log = (...args) => console.log(new Date().toLocaleString('es-AR', TIME_FORMAT), ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function telegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

async function send(chatId, text, { silent = false } = {}) {
  try {
    return await telegram('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      disable_notification: silent,
    });
  } catch (err) {
    log(`No pude mandar el Telegram a ${chatId}:`, err.message);
  }
}

const notify = (text, options) => Promise.all(CHAT_IDS.map((chatId) => send(chatId, text, options)));

// Routine "still sold out" updates go into one message per chat that we keep editing, since
// Telegram never notifies edits. Silent sends still pop a banner. If it gets deleted, we start a new one.
// The status message stays pinned so the next run (each Actions job is a fresh process) picks it up.
const statusMessageIds = new Map();

async function adoptPinnedStatus(chatId) {
  const pinned = (await telegram('getChat', { chat_id: chatId }).catch(() => null))?.pinned_message;
  if (pinned?.text?.startsWith(STATUS_PREFIX)) statusMessageIds.set(chatId, pinned.message_id);
}

async function updateStatusIn(chatId, text) {
  const messageId = statusMessageIds.get(chatId);
  if (messageId) {
    try {
      await telegram('editMessageText', { chat_id: chatId, message_id: messageId, text });
      return;
    } catch (err) {
      // A network blip (fetch throws TypeError) just skips this update. Only a Telegram-side
      // rejection means the message is gone and we need a fresh one.
      if (err instanceof TypeError) {
        log(`No pude editar el estado en ${chatId} (red), sigo:`, err.message);
        return;
      }
      log(`No pude editar el estado en ${chatId}, mando uno nuevo:`, err.message);
    }
  }
  const sent = await send(chatId, text, { silent: true });
  if (!sent) return;
  statusMessageIds.set(chatId, sent.message_id);
  await telegram('pinChatMessage', { chat_id: chatId, message_id: sent.message_id, disable_notification: true }).catch(
    (err) => log(`No pude fijar el estado en ${chatId}:`, err.message),
  );
}

const updateStatus = (text) => Promise.all(CHAT_IDS.map((chatId) => updateStatusIn(chatId, text)));

// Asks Windows not to sleep while we run. The helper exits on its own when this process dies.
function keepAwake() {
  const ps = [
    `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
    `[W.P]::SetThreadExecutionState(0x80000001) | Out-Null`,
    `Wait-Process -Id ${process.pid}`,
  ].join('; ');
  spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
}

async function launch() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'es-AR' });
  await context.route('**/*', (route) =>
    ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue(),
  );
  return { browser, page: await context.newPage() };
}

// Each date is an .evento-row. Sold out means the button reads "Agotado" and carries btn-disabled.
async function readDates(page) {
  await page.goto(SHOW_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('.evento-row button.btn-comprar', { timeout: 45_000 });
  return page.$$eval('.evento-row', (rows) =>
    rows.map((row) => {
      const btn = row.querySelector('button.btn-comprar');
      const label = btn?.textContent.trim() ?? '';
      return {
        date: `${row.querySelector('.fecha p')?.textContent.trim()} ${row.querySelector('.fecha span')?.textContent.trim()}`,
        label,
        available: !!btn && !/agotado/i.test(label) && !btn.classList.contains('btn-disabled'),
      };
    }),
  );
}

const summary = (dates) => dates.map((d) => `${d.date}: ${d.label}`).join('\n');

async function main() {
  if (!TOKEN || !CHAT_IDS.length) throw new Error('Faltan TELEGRAM_TOKEN o TELEGRAM_CHAT_IDS');
  if (process.platform === 'win32') keepAwake();
  await Promise.all(CHAT_IDS.map(adoptPinnedStatus));

  let { browser, page } = await launch();
  let failures = 0;
  const deadline = MAX_RUNTIME_MS ? Date.now() + MAX_RUNTIME_MS : Infinity;

  while (Date.now() < deadline) {
    const startedAt = Date.now();
    try {
      if (!browser.isConnected()) ({ browser, page } = await launch());
      const dates = await readDates(page);
      const current = summary(dates);
      const open = dates.filter((d) => d.available && WATCHED_DATES.includes(d.date));

      if (failures >= FAILURES_BEFORE_ALERT) await notify('La página volvió a cargar bien, sigo monitoreando.', { silent: true });
      failures = 0;
      log(current.replaceAll('\n', ' | '));

      // Loud and repeated on every check while anything is open, so it can't be missed.
      if (open.length) {
        await notify(`🚨 HAY ENTRADAS: ${open.map((d) => d.date).join(', ')}\n\n${current}\n\n${SHOW_URL}`);
      }
      const time = new Date().toLocaleTimeString('es-AR', TIME_FORMAT);
      await updateStatus(`${STATUS_PREFIX} Monitoreando ${WATCHED_DATES.join(', ')} cada ~15s\nÚltimo chequeo: ${time}\n\n${current || 'No hay fechas en la página'}`);
    } catch (err) {
      failures++;
      log(`Error (${failures}):`, err.message);
      if (failures === FAILURES_BEFORE_ALERT) {
        await notify(`⚠️ No puedo leer la página hace ${failures} intentos: ${err.message}\nSigo intentando.`);
      }
      // A stuck page or crashed browser is cheaper to replace than to debug mid-run.
      await browser.close().catch(() => {});
      ({ browser, page } = await launch().catch(() => ({ browser, page })));
    }
    // The interval counts from the start of each check, so page load time doesn't stretch it.
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - startedAt)) + Math.random() * JITTER_MS);
  }
  log('Llegué al tiempo máximo de esta corrida, la sigue la próxima.');
  await browser.close().catch(() => {});
}

main().then(() => process.exit(0), async (err) => {
  log('Se cayó el monitor:', err);
  await notify(`❌ El monitor se cayó: ${err.message}`);
  process.exit(1);
});
