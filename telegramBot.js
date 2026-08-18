const crypto = require("crypto");

const PLANS = {
  "7": { code: "7", name: "7 дней", stars: 100, days: 7, label: "Red Music VIP — 7 дней" },
  "30": { code: "30", name: "30 дней", stars: 220, days: 30, label: "Red Music VIP — 30 дней" },
  "life": { code: "life", name: "Навсегда", stars: 999, days: null, label: "Red Music VIP — Навсегда" },
};

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_CHAT_ID = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
const EXPLICIT_BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");

let botUsername = EXPLICIT_BOT_USERNAME;
let polling = false;
let stopped = false;
let updateOffset = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtUsername(user) {
  const username = String(user?.username || "").trim();
  return username ? `@${username}` : "отсутствует";
}
function fmtDate(value) {
  if (!value) return "Без ограничения";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("ru-RU", { timeZone: "Europe/Chisinau" });
}
function nowIso() { return new Date().toISOString(); }
function planFromCode(code) { return PLANS[String(code || "")] || null; }

async function telegramApi(method, body = {}) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram API ${method}: ${data.description || `HTTP ${response.status}`}`);
  }
  return data.result;
}
async function getBotUsername() {
  if (botUsername) return botUsername;
  if (!BOT_TOKEN) return "";
  try {
    const me = await telegramApi("getMe");
    botUsername = String(me.username || "").replace(/^@/, "");
    return botUsername;
  } catch (error) {
    console.error("[telegram] getMe:", error.message);
    return "";
  }
}
async function sendMessage(chatId, text, extra = {}) {
  return telegramApi("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    disable_web_page_preview: true, ...extra,
  });
}
async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) {
    console.warn("[telegram] TELEGRAM_ADMIN_CHAT_ID не задан, уведомление не отправлено.");
    return;
  }
  try { await sendMessage(ADMIN_CHAT_ID, text); }
  catch (error) { console.error("[telegram] Ошибка уведомления админа:", error.message); }
}

function upsertTelegramUser(db, tgUser) {
  const telegramId = String(tgUser.id);
  const existing = db.prepare("SELECT * FROM telegram_users WHERE telegram_id = ?").get(telegramId);
  const username = String(tgUser.username || "");
  const firstName = String(tgUser.first_name || "");
  const lastName = String(tgUser.last_name || "");

  if (!existing) {
    db.prepare(`
      INSERT INTO telegram_users
        (telegram_id, username, first_name, last_name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(telegramId, username, firstName, lastName);

    notifyAdmin(
      `<b>🆕 НОВЫЙ ПОЛЬЗОВАТЕЛЬ</b>\n\n` +
      `<b>Telegram ID:</b> <code>${escapeHtml(telegramId)}</code>\n` +
      `<b>Username:</b> ${escapeHtml(fmtUsername(tgUser))}\n` +
      `<b>Имя:</b> ${escapeHtml([firstName, lastName].filter(Boolean).join(" ") || "не указано")}\n` +
      `<b>Дата:</b> ${escapeHtml(fmtDate(nowIso()))}\n` +
      `<b>Статус:</b> Новый пользователь`
    ).catch(() => {});
    return true;
  }

  db.prepare(`
    UPDATE telegram_users
    SET username = ?, first_name = ?, last_name = ?, last_seen_at = datetime('now')
    WHERE telegram_id = ?
  `).run(username, firstName, lastName, telegramId);
  return false;
}

function mainKeyboard() {
  return { inline_keyboard: [
    [{ text: "🎵 Купить подписку", callback_data: "plans" }],
    [{ text: "💎 Тарифы", callback_data: "plans" }],
    [{ text: "👤 Моя подписка", callback_data: "my_subscription" }],
    [{ text: "❓ Помощь", callback_data: "help" }],
  ]};
}
function plansKeyboard() {
  return { inline_keyboard: [
    [{ text: "⭐ 7 дней — 100 Stars", callback_data: "buy:7" }],
    [{ text: "⭐ 30 дней — 220 Stars", callback_data: "buy:30" }],
    [{ text: "⭐ Навсегда — 999 Stars", callback_data: "buy:life" }],
    [{ text: "↩️ Главное меню", callback_data: "home" }],
  ]};
}
async function sendHome(chatId, firstName = "") {
  const name = firstName ? `, ${escapeHtml(firstName)}` : "";
  await sendMessage(chatId,
    `<b>🎵 Red Music</b>\n\nДобро пожаловать${name}!\n` +
    `Здесь можно оформить подписку Red Music через Telegram Stars ⭐.\n\n` +
    `<b>Выберите действие:</b>`, { reply_markup: mainKeyboard() });
}
async function sendPlans(chatId) {
  await sendMessage(chatId,
    `<b>💎 Тарифы Red Music</b>\n\n` +
    `⭐ <b>7 дней</b> — 100 Stars\n` +
    `⭐ <b>30 дней</b> — 220 Stars\n` +
    `⭐ <b>Навсегда</b> — 999 Stars\n\nВыберите нужный тариф:`,
    { reply_markup: plansKeyboard() });
}
function getLinkedAppUser(db, telegramId) {
  return db.prepare(`
    SELECT u.* FROM telegram_users tu
    JOIN users u ON u.id = tu.app_user_id
    WHERE tu.telegram_id = ?
  `).get(String(telegramId)) || null;
}
function getAppRoles(db, userId) {
  return db.prepare(`
    SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ?
  `).all(userId).map(row => row.name);
}
function ensureVipRole(db, userId) {
  const vip = db.prepare("SELECT id FROM roles WHERE name = 'VIP'").get();
  if (vip) db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)").run(userId, vip.id);
}
function calculateExpiry(db, userId, days) {
  const user = db.prepare("SELECT vip_until FROM users WHERE id = ?").get(userId);
  const now = Date.now();
  const current = user?.vip_until ? new Date(user.vip_until).getTime() : 0;
  const base = Number.isFinite(current) && current > now ? current : now;
  return new Date(base + days * 86400000).toISOString();
}
function activateAppSubscription(db, appUserId, plan) {
  ensureVipRole(db, appUserId);
  if (plan.days === null) {
    db.prepare("UPDATE users SET vip_until = NULL WHERE id = ?").run(appUserId);
    return null;
  }
  const expires = calculateExpiry(db, appUserId, plan.days);
  db.prepare("UPDATE users SET vip_until = ? WHERE id = ?").run(expires, appUserId);
  return expires;
}
async function sendInvoiceForPlan(db, chatId, telegramId, planCode) {
  const plan = planFromCode(planCode);
  if (!plan) return;
  const linked = db.prepare(
    "SELECT pending_link_token FROM telegram_users WHERE telegram_id = ?"
  ).get(String(telegramId));
  const token = String(linked?.pending_link_token || "");
  const payload = `rm|${plan.code}|${token}`;
  await telegramApi("sendInvoice", {
    chat_id: chatId,
    title: plan.label,
    description: `Подписка Red Music: ${plan.name}. Оплата через Telegram Stars.`,
    payload,
    currency: "XTR",
    prices: [{ label: plan.label, amount: plan.stars }],
    provider_token: "",
    start_parameter: `rm-${plan.code}`,
  });
}
async function sendSelectedPlan(chatId, plan) {
  await sendMessage(chatId,
    `<b>🎵 Red Music VIP</b>\n\n` +
    `<b>Тариф:</b> ${escapeHtml(plan.name)}\n` +
    `<b>Цена:</b> ⭐ ${plan.stars}\n\n` +
    `Нажмите кнопку ниже для оплаты через Telegram Stars.`,
    { reply_markup: { inline_keyboard: [
      [{ text: `⭐ Оплатить ${plan.stars} Stars`, callback_data: `buy:${plan.code}` }],
      [{ text: "💎 Другие тарифы", callback_data: "plans" }],
    ]}});
}
async function showMySubscription(db, chatId, telegramId) {
  const linked = getLinkedAppUser(db, telegramId);
  const tgSub = db.prepare(`
    SELECT * FROM telegram_purchases
    WHERE telegram_id = ? AND status = 'paid'
    ORDER BY purchased_at DESC LIMIT 1
  `).get(String(telegramId));

  if (!linked && !tgSub) {
    await sendMessage(chatId, `<b>👤 Моя подписка</b>\n\nПодписка пока не найдена.\n\nОформите её через меню.`,
      { reply_markup: mainKeyboard() });
    return;
  }
  const roles = linked ? getAppRoles(db, linked.id) : [];
  const active = linked ? roles.includes("VIP") : !!tgSub;
  const expiry = linked ? linked.vip_until : tgSub?.expires_at;
  await sendMessage(chatId,
    `<b>👤 Моя подписка</b>\n\n` +
    `<b>Статус:</b> ${active ? "🟢 Активна" : "⚪ Не активна"}\n` +
    `<b>Тариф:</b> ${escapeHtml(tgSub?.plan_name || "Red Music VIP")}\n` +
    `<b>Окончание:</b> ${escapeHtml(expiry ? fmtDate(expiry) : "Бессрочно")}\n` +
    (linked ? `<b>Аккаунт Red Music:</b> @${escapeHtml(linked.username)}` : ""),
    { reply_markup: mainKeyboard() });
}
async function handleSuccessfulPayment(db, message) {
  const payment = message.successful_payment;
  const telegramId = String(message.from.id);
  const payload = String(payment.invoice_payload || "");
  const parts = payload.split("|");
  const plan = planFromCode(parts[1]);
  const linkToken = String(parts[2] || "");
  if (!plan) {
    console.error("[telegram] Неизвестный план:", payload);
    return;
  }
  const chargeId = String(payment.telegram_payment_charge_id || "");
  const already = db.prepare(
    "SELECT id FROM telegram_purchases WHERE telegram_payment_charge_id = ?"
  ).get(chargeId);
  if (already) return;

  const tokenRow = linkToken ? db.prepare(
    "SELECT * FROM telegram_link_tokens WHERE token = ? AND used_at IS NULL"
  ).get(linkToken) : null;
  let appUserId = tokenRow ? Number(tokenRow.user_id) : null;
  if (tokenRow?.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) appUserId = null;

  const expiresAt = appUserId ? activateAppSubscription(db, appUserId, plan) : null;
  const tg = db.prepare("SELECT username FROM telegram_users WHERE telegram_id = ?").get(telegramId);
  const purchaseInfo = db.prepare(`
    INSERT INTO telegram_purchases
      (telegram_id, app_user_id, plan_code, plan_name, stars, duration_days,
       purchased_at, expires_at, telegram_payment_charge_id, invoice_payload, status)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, 'paid')
  `).run(
    telegramId, appUserId || null, plan.code, plan.name, plan.stars, plan.days,
    expiresAt, chargeId, payload
  );

  db.prepare(`
    UPDATE telegram_users
    SET app_user_id = COALESCE(?, app_user_id),
        pending_link_token = NULL, last_seen_at = datetime('now')
    WHERE telegram_id = ?
  `).run(appUserId || null, telegramId);

  if (tokenRow) db.prepare(
    "UPDATE telegram_link_tokens SET used_at = datetime('now') WHERE token = ?"
  ).run(linkToken);

  const purchaseNumber = Number(purchaseInfo.lastInsertRowid);
  const username = tg?.username ? `@${tg.username}` : "отсутствует";
  const ending = expiresAt ? fmtDate(expiresAt) : "Без ограничения";

  await notifyAdmin(
    `<b>Оплата подтверждена</b>\n\n` +
    `<b>Сумма:</b> ⭐ ${plan.stars}\n` +
    `<b>Срок:</b> ${escapeHtml(plan.name)}\n` +
    `<b>Название:</b> ${escapeHtml(plan.label)}\n` +
    `<b>Telegram ID:</b> <code>${escapeHtml(telegramId)}</code>\n` +
    `<b>Username:</b> ${escapeHtml(username)}\n` +
    `<b>Подписка:</b> ${escapeHtml(plan.name)}\n` +
    `<b>Окончание:</b> ${escapeHtml(ending)}\n\n` +
    `<b>🆕 #${String(purchaseNumber).padStart(4, "0")} ID ${escapeHtml(telegramId)} | ${escapeHtml(username)} | ${escapeHtml(plan.name)}</b>`
  );

  await sendMessage(message.chat.id,
    `<b>✅ Оплата подтверждена!</b>\n\n` +
    `<b>Подписка:</b> ${escapeHtml(plan.name)}\n` +
    `<b>Оплачено:</b> ⭐ ${plan.stars}\n` +
    `<b>Окончание:</b> ${escapeHtml(ending)}\n\n` +
    (appUserId
      ? `Подписка активирована в Red Music автоматически.`
      : `Оплата сохранена. Чтобы привязать её к аккаунту Red Music, начните покупку из приложения.`),
    { reply_markup: mainKeyboard() });
}
async function handleMessage(db, message) {
  if (!message.from || !message.chat) return;
  upsertTelegramUser(db, message.from);

  if (message.successful_payment) {
    await handleSuccessfulPayment(db, message);
    return;
  }
  const text = String(message.text || "").trim();
  if (!text) return;

  if (/^\/id\b/i.test(text)) {
    await sendMessage(message.chat.id, `<b>Ваш Telegram ID:</b> <code>${escapeHtml(message.from.id)}</code>`);
    return;
  }
  if (/^\/start\b/i.test(text)) {
    const param = text.split(/\s+/, 2)[1] || "";
    if (param) {
      const tokenRow = db.prepare(`
        SELECT * FROM telegram_link_tokens
        WHERE token = ? AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > datetime('now'))
      `).get(param);

      if (tokenRow) {
        db.prepare(`
          UPDATE telegram_users
          SET app_user_id = ?, pending_link_token = ?, last_seen_at = datetime('now')
          WHERE telegram_id = ?
        `).run(tokenRow.user_id, tokenRow.token, String(message.from.id));

        const plan = planFromCode(tokenRow.plan_code);
        if (plan) {
          await sendSelectedPlan(message.chat.id, plan);
          return;
        }
      }
    }
    await sendHome(message.chat.id, message.from.first_name || "");
    return;
  }
  if (/^\/help\b/i.test(text)) {
    await sendMessage(message.chat.id,
      `<b>❓ Помощь</b>\n\nВыберите тариф и оплатите его через Telegram Stars ⭐.\n` +
      `Если переходите из приложения Red Music, выбранный тариф автоматически связывается с вашим аккаунтом.`,
      { reply_markup: mainKeyboard() });
    return;
  }
  await sendHome(message.chat.id, message.from.first_name || "");
}
async function handleCallback(db, callback) {
  const from = callback.from;
  const chatId = callback.message?.chat?.id;
  if (!from || !chatId) return;
  upsertTelegramUser(db, from);
  try { await telegramApi("answerCallbackQuery", { callback_query_id: callback.id }); } catch (_) {}

  const data = String(callback.data || "");
  if (data === "home") return sendHome(chatId, from.first_name || "");
  if (data === "plans") return sendPlans(chatId);
  if (data === "my_subscription") return showMySubscription(db, chatId, from.id);
  if (data === "help") return sendMessage(chatId,
    `<b>❓ Помощь</b>\n\nВыберите тариф, нажмите кнопку покупки и подтвердите оплату Stars ⭐.\n` +
    `Если покупка начата из Red Music, подписка автоматически связывается с вашим аккаунтом.`,
    { reply_markup: mainKeyboard() });

  const match = /^buy:(7|30|life)$/.exec(data);
  if (match) await sendInvoiceForPlan(db, chatId, from.id, match[1]);
}
async function processUpdate(db, update) {
  if (update.callback_query) return handleCallback(db, update.callback_query);
  if (update.pre_checkout_query) {
    try {
      await telegramApi("answerPreCheckoutQuery", {
        pre_checkout_query_id: update.pre_checkout_query.id, ok: true
      });
    } catch (error) { console.error("[telegram] pre_checkout:", error.message); }
    return;
  }
  if (update.message) return handleMessage(db, update.message);
}
async function pollingLoop(db) {
  if (polling || stopped) return;
  polling = true;
  while (!stopped) {
    try {
      const updates = await telegramApi("getUpdates", {
        offset: updateOffset, timeout: 20,
        allowed_updates: ["message", "callback_query", "pre_checkout_query"],
      });
      for (const update of updates) {
        updateOffset = Number(update.update_id) + 1;
        try { await processUpdate(db, update); }
        catch (error) { console.error("[telegram] Ошибка update:", error.stack || error.message); }
      }
    } catch (error) {
      if (stopped) break;
      console.error("[telegram] Polling:", error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  polling = false;
}
async function startTelegramBot(db) {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN не задан. Telegram-бот отключён.");
    return { enabled: false, username: "" };
  }
  try {
    await telegramApi("deleteWebhook", { drop_pending_updates: false });
    const me = await telegramApi("getMe");
    botUsername = String(me.username || "").replace(/^@/, "");
    await telegramApi("setMyCommands", { commands: [
      { command: "start", description: "Открыть главное меню" },
      { command: "id", description: "Показать Telegram ID" },
      { command: "help", description: "Помощь" },
    ]});
    console.log(`[telegram] Бот @${botUsername} запущен`);
    pollingLoop(db).catch(error => console.error("[telegram] Polling fatal:", error));
    return { enabled: true, username: botUsername };
  } catch (error) {
    console.error("[telegram] Не удалось запустить бота:", error.message);
    return { enabled: false, username: botUsername };
  }
}
function getPlans() { return Object.values(PLANS).map(plan => ({ ...plan })); }
module.exports = { PLANS, startTelegramBot, getBotUsername, createLinkToken: () => crypto.randomBytes(24).toString("base64url"), getPlans };
