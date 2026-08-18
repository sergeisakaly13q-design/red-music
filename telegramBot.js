const crypto = require("crypto");

const PLANS = {
  "7": { code: "7", name: "7 дней", stars: 100, days: 7, label: "Red Music VIP — 7 дней" },
  "30": { code: "30", name: "30 дней", stars: 220, days: 30, label: "Red Music VIP — 30 дней" },
  "life": { code: "life", name: "Навсегда", stars: 999, days: null, label: "Red Music VIP — Навсегда" },
};

const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ADMIN_CHAT_ID = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
const OWNER_TELEGRAM_ID = String(process.env.OWNER_TELEGRAM_ID || "7665540013").trim();
const EXPLICIT_BOT_USERNAME = String(process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");
const WEBAPP_URL = String(process.env.WEBAPP_URL || "https://red-music.onrender.com").trim().replace(/\/$/, "");
const OFFICIAL_BOT_USERNAME = "RedMusicPremiumBot";

let botUsername = EXPLICIT_BOT_USERNAME;
let polling = false;
let stopped = false;
let updateOffset = 0;

// Кэш для отслеживания состояния пользователя (ожидание ввода App User ID)
const userStates = new Map();

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
function isOwner(telegramId) { return String(telegramId) === OWNER_TELEGRAM_ID; }

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
    if (botUsername && botUsername.toLowerCase() !== OFFICIAL_BOT_USERNAME.toLowerCase()) {
      console.warn(
        `[telegram] ВНИМАНИЕ: TELEGRAM_BOT_TOKEN указывает на @${botUsername}, ` +
        `а не на официального бота @${OFFICIAL_BOT_USERNAME}. Ссылки в WebApp ` +
        `будут вести на @${botUsername}. Проверьте TELEGRAM_BOT_TOKEN в .env.`
      );
    }
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

    try {
      db.prepare(`
        INSERT OR IGNORE INTO telegram_user_balance (telegram_id, test_stars, real_stars, created_at, updated_at)
        VALUES (?, 0, 0, datetime('now'), datetime('now'))
      `).run(telegramId);
    } catch (e) {
      console.error("[telegram] Ошибка при создании баланса:", e.message);
    }

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

function getTelegramUserBalance(db, telegramId) {
  const telegramIdStr = String(telegramId);
  try {
    const balance = db.prepare("SELECT * FROM telegram_user_balance WHERE telegram_id = ?").get(telegramIdStr);
    if (balance) return balance;
  } catch (e) {
    console.error("[telegram] Ошибка при получении баланса:", e.message);
  }
  return { telegram_id: telegramIdStr, test_stars: 0, real_stars: 0 };
}

function addTestStars(db, telegramId, amount) {
  const telegramIdStr = String(telegramId);
  try {
    db.prepare(`
      UPDATE telegram_user_balance
      SET test_stars = test_stars + ?, updated_at = datetime('now')
      WHERE telegram_id = ?
    `).run(amount, telegramIdStr);
    return getTelegramUserBalance(db, telegramId);
  } catch (e) {
    console.error("[telegram] Ошибка при добавлении звёзд:", e.message);
    return getTelegramUserBalance(db, telegramId);
  }
}

function spendStars(db, telegramId, amount) {
  const balance = getTelegramUserBalance(db, telegramId);
  const totalStars = (balance.test_stars || 0) + (balance.real_stars || 0);
  if (totalStars < amount) {
    return { success: false, message: `Недостаточно звёзд. Требуется: ${amount}, у вас есть: ${totalStars}` };
  }
  const telegramIdStr = String(telegramId);
  let remaining = amount;
  try {
    if (balance.real_stars >= remaining) {
      db.prepare(`
        UPDATE telegram_user_balance
        SET real_stars = real_stars - ?, updated_at = datetime('now')
        WHERE telegram_id = ?
      `).run(remaining, telegramIdStr);
    } else {
      const useRealStars = balance.real_stars || 0;
      remaining -= useRealStars;
      db.prepare(`
        UPDATE telegram_user_balance
        SET real_stars = 0, test_stars = test_stars - ?, updated_at = datetime('now')
        WHERE telegram_id = ?
      `).run(remaining, telegramIdStr);
    }
  } catch (e) {
    console.error("[telegram] Ошибка при трате звёзд:", e.message);
    return { success: false, message: `Ошибка: ${e.message}` };
  }
  return { success: true, message: "Звёзды потрачены успешно" };
}

function mainKeyboard() {
  return { inline_keyboard: [
    [{ text: "🎵 Купить подписку", callback_data: "buy_now" }],
    [{ text: "💎 Тарифы", callback_data: "plans" }],
    [{ text: "👤 Профиль", callback_data: "profile" }],
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

function helpText() {
  return (
    `<b>❓ Помощь Red Music</b>\n\n` +
    `Здесь можно оформить VIP-подписку через Telegram Stars ⭐ и управлять ей.\n\n` +
    `<b>🎵 Купить подписку</b> — оформить или продлить VIP\n` +
    `<b>💎 Тарифы</b> — посмотреть все доступные планы\n` +
    `<b>👤 Профиль</b> — посмотреть баланс и статус подписки\n\n` +
    `<b>🛠 Остались вопросы или что-то не работает?</b>\n` +
    `По любым вопросам, ошибкам и проблемам с оплатой обращайтесь к администраторам:\n\n` +
    `👤 @rawsjsjsj\n` +
    `👤 @k4ydz0me\n\n` +
    `Мы поможем как можно скорее! 💬`
  );
}

async function sendHome(chatId, firstName = "") {
  const name = firstName ? `, ${escapeHtml(firstName)}` : "";
  await sendMessage(chatId,
    `<b>🎵 Red Music</b>\n\nДобро пожаловать${name}!\n` +
    `Здесь можно оформить подписку Red Music через Telegram Stars ⭐.\n\n` +
    `<b>Выберите действие:</b>`, { reply_markup: mainKeyboard() });
}

async function sendPlans(chatId, intro = "<b>💎 Тарифы Red Music</b>") {
  await sendMessage(chatId,
    `${intro}\n\n` +
    `⭐ <b>7 дней</b> — 100 Stars\n` +
    `⭐ <b>30 дней</b> — 220 Stars\n` +
    `⭐ <b>Навсегда</b> — 999 Stars\n\nВыберите нужный тариф:`,
    { reply_markup: plansKeyboard() });
}

async function sendProfile(db, chatId, telegramId) {
  const balance = getTelegramUserBalance(db, telegramId);
  const totalStars = (balance.test_stars || 0) + (balance.real_stars || 0);
  const linked = db.prepare(`
    SELECT u.* FROM telegram_users tu
    JOIN users u ON u.id = tu.app_user_id
    WHERE tu.telegram_id = ?
  `).get(String(telegramId)) || null;
  const roles = linked ? db.prepare(`
    SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ?
  `).all(linked.id).map(row => row.name) : [];
  const hasVip = roles.includes("VIP");

  await sendMessage(chatId,
    `<b>👤 Ваш профиль</b>\n\n` +
    `<b>💰 Баланс:</b> ⭐ ${totalStars} звёзд\n` +
    `  └ Тестовых: ⭐ ${balance.test_stars || 0}\n` +
    `  └ Реальных: ⭐ ${balance.real_stars || 0}\n\n` +
    `<b>📊 Статус подписки:</b> ${hasVip ? "🟢 VIP активна" : "⚪ Обычный пользователь"}\n` +
    (linked && linked.vip_until ? `<b>Окончание:</b> ${escapeHtml(fmtDate(linked.vip_until))}\n` : "") +
    `\n<b>Выберите действие:</b>`,
    { reply_markup: { inline_keyboard: [
      [{ text: "🎵 Купить подписку", callback_data: "buy_now" }],
      [{ text: "↩️ Главное меню", callback_data: "home" }],
    ]}});
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
  const balance = getTelegramUserBalance(db, telegramId);
  const totalStars = (balance.test_stars || 0) + (balance.real_stars || 0);
  
  if (totalStars >= plan.stars) {
    // Есть тестовые звёзды, можно купить через них
    await sendMessage(chatId,
      `<b>⭐ Подтверждение покупки</b>\n\n` +
      `<b>Тариф:</b> ${escapeHtml(plan.name)}\n` +
      `<b>Цена:</b> ⭐ ${plan.stars}\n` +
      `<b>Ваш баланс:</b> ⭐ ${totalStars}\n\n` +
      `Подтвердить покупку за тестовые звёзды?`,
      { reply_markup: { inline_keyboard: [
        [{ text: `✅ Подтвердить`, callback_data: `confirm_test:${plan.code}` }],
        [{ text: "❌ Отменить", callback_data: "plans" }],
      ]}});
  } else {
    // Предложить купить через обычный способ
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
}

async function confirmTestPurchase(db, chatId, telegramId, planCode) {
  const plan = planFromCode(planCode);
  if (!plan) return;
  
  const spendResult = spendStars(db, telegramId, plan.stars);
  if (!spendResult.success) {
    await sendMessage(chatId, `<b>❌ Ошибка</b>\n\n${spendResult.message}`);
    return;
  }

  // Сохраняем информацию о покупке для следующего шага
  userStates.set(String(telegramId), {
    waitingForAppUserId: true,
    plan,
    purchaseTime: Date.now()
  });

  await sendMessage(chatId,
    `<b>✅ Звёзды списаны!</b>\n\n` +
    `<b>Подписка:</b> ${escapeHtml(plan.name)}\n` +
    `<b>Цена:</b> ⭐ ${plan.stars}\n\n` +
    `Теперь напишите ваш <b>App User ID</b> из приложения Red Music\n` +
    `чтобы активировать подписку.\n\n` +
    `<i>Это число, которое вы видите в профиле приложения</i>`);
}

async function handleAppUserIdInput(db, chatId, telegramId, userInput) {
  const state = userStates.get(String(telegramId));
  if (!state || !state.waitingForAppUserId) {
    await sendMessage(chatId, `<b>❌ Ошибка</b>\n\nСначала купите подписку.`);
    return;
  }

  // Проверяем, не истёк ли таймаут (30 минут)
  if (Date.now() - state.purchaseTime > 30 * 60 * 1000) {
    userStates.delete(String(telegramId));
    await sendMessage(chatId, `<b>❌ Время истекло</b>\n\nПопробуйте купить подписку снова.`);
    return;
  }

  const appUserId = parseInt(userInput.trim(), 10);
  if (isNaN(appUserId) || appUserId <= 0) {
    await sendMessage(chatId, `<b>❌ Ошибка</b>\n\nID должен быть положительным числом.\n\nПожалуйста, напишите корректный ID.`);
    return;
  }

  // Проверяем, существует ли такой пользователь в приложении
  const appUser = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(appUserId);
  if (!appUser) {
    await sendMessage(chatId, `<b>❌ Пользователь не найден</b>\n\nID <code>${appUserId}</code> не существует в Red Music.\n\nПожалуйста, проверьте ID и напишите снова.`);
    return;
  }

  const plan = state.plan;
  
  try {
    // Привязываем аккаунты
    db.prepare(`
      UPDATE telegram_users
      SET app_user_id = ?, pending_link_token = NULL
      WHERE telegram_id = ?
    `).run(appUserId, String(telegramId));

    // Активируем ВИП подписку
    const expiresAt = activateAppSubscription(db, appUserId, plan);
    const ending = expiresAt ? fmtDate(expiresAt) : "Без ограничения";

    // Удаляем состояние
    userStates.delete(String(telegramId));

    // Сообщение пользователю
    await sendMessage(chatId,
      `<b>✅ Подписка активирована!</b>\n\n` +
      `<b>Пользователь:</b> ${escapeHtml(appUser.display_name || appUser.username)}\n` +
      `<b>Подписка:</b> ${escapeHtml(plan.name)}\n` +
      `<b>Окончание:</b> ${escapeHtml(ending)}\n\n` +
      `Зайдите в приложение Red Music чтобы увидеть активный ВИП статус!`,
      { reply_markup: mainKeyboard() });

    // Уведомление админу
    const tg = db.prepare("SELECT username FROM telegram_users WHERE telegram_id = ?").get(String(telegramId));
    const username = tg?.username ? `@${tg.username}` : "отсутствует";
    
    await notifyAdmin(
      `<b>✅ Тестовая подписка активирована</b>\n\n` +
      `<b>Сумма:</b> ⭐ ${plan.stars} (тестовые)\n` +
      `<b>Срок:</b> ${escapeHtml(plan.name)}\n` +
      `<b>Telegram ID:</b> <code>${escapeHtml(String(telegramId))}</code>\n` +
      `<b>Username:</b> ${escapeHtml(username)}\n` +
      `<b>App User ID:</b> <code>${appUserId}</code>\n` +
      `<b>Аккаунт Red Music:</b> ${escapeHtml(appUser.display_name || appUser.username)}\n` +
      `<b>Окончание:</b> ${escapeHtml(ending)}`
    );
  } catch (error) {
    console.error("[telegram] Ошибка при активации подписки:", error.message);
    await sendMessage(chatId, `<b>❌ Ошибка</b>\n\nНе удалось активировать подписку.\n\n${error.message}`);
  }
}

async function sendSuccessfulPayment(db, message) {
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
    await sendSuccessfulPayment(db, message);
    return;
  }

  const text = String(message.text || "").trim();
  if (!text) return;

  // Проверяем, ожидает ли пользователь ввода App User ID
  const state = userStates.get(String(message.from.id));
  if (state && state.waitingForAppUserId) {
    await handleAppUserIdInput(db, message.chat.id, message.from.id, text);
    return;
  }

  if (/^\/id\b/i.test(text)) {
    await sendMessage(message.chat.id, `<b>Ваш Telegram ID:</b> <code>${escapeHtml(message.from.id)}</code>`);
    return;
  }

  if (/^\/give\b/i.test(text)) {
    if (!isOwner(message.from.id)) {
      await sendMessage(message.chat.id, `<b>❌ Ошибка</b>\n\nЭта команда доступна только Owner.`);
      return;
    }

    const parts = text.split(/\s+/);
    if (parts.length < 3) {
      await sendMessage(message.chat.id,
        `<b>❌ Неверный формат</b>\n\n` +
        `Используйте: <code>/give [user_id] [количество_звёзд]</code>\n\n` +
        `Пример: <code>/give 123456789 500</code>`);
      return;
    }

    const targetUserId = String(parts[1]);
    const amount = parseInt(parts[2], 10);

    if (isNaN(amount) || amount <= 0) {
      await sendMessage(message.chat.id, `<b>❌ Ошибка</b>\n\nКоличество звёзд должно быть положительным числом.`);
      return;
    }

    try {
      const before = getTelegramUserBalance(db, targetUserId);
      const after = addTestStars(db, targetUserId, amount);

      await sendMessage(message.chat.id,
        `<b>✅ Тестовые звёзды выданы</b>\n\n` +
        `<b>Пользователю:</b> <code>${escapeHtml(targetUserId)}</code>\n` +
        `<b>Количество:</b> ⭐ ${amount}\n\n` +
        `<b>Баланс до:</b> ⭐ ${(before.test_stars || 0) + (before.real_stars || 0)}\n` +
        `<b>Баланс после:</b> ⭐ ${(after.test_stars || 0) + (after.real_stars || 0)}`);

      await notifyAdmin(
        `<b>💫 Тестовые звёзды выданы</b>\n\n` +
        `<b>Owner ID:</b> <code>${escapeHtml(String(message.from.id))}</code>\n` +
        `<b>Выдано пользователю:</b> <code>${escapeHtml(targetUserId)}</code>\n` +
        `<b>Количество:</b> ⭐ ${amount}`
      );
    } catch (error) {
      console.error("[telegram] Ошибка /give:", error.message);
      await sendMessage(message.chat.id, `<b>❌ Ошибка при выдаче звёзд</b>\n\n${error.message}`);
    }
    return;
  }

  if (/^\/start\b/i.test(text)) {
    const param = text.split(/\s+/, 2)[1] || "";
    if (param) {
      const guestMatch = /^plan_(7|30|life)$/.exec(param);
      if (guestMatch) {
        const plan = planFromCode(guestMatch[1]);
        if (plan) {
          await sendPlans(message.chat.id, `<b>🎵 Red Music VIP</b>\n\n<b>Тариф:</b> ${escapeHtml(plan.name)}`);
          return;
        }
      }

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
          await sendPlans(message.chat.id, `<b>🎵 Red Music VIP</b>\n\n<b>Тариф:</b> ${escapeHtml(plan.name)}`);
          return;
        }
      }
    }
    await sendHome(message.chat.id, message.from.first_name || "");
    return;
  }

  if (/^\/help\b/i.test(text)) {
    await sendMessage(message.chat.id, helpText(), { reply_markup: mainKeyboard() });
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
  if (data === "plans") return sendPlans(chatId, "<b>💎 Тарифы Red Music</b>");
  if (data === "buy_now") return sendPlans(chatId, "<b>🎵 Оформление подписки Red Music</b>");
  if (data === "profile") return sendProfile(db, chatId, from.id);
  if (data === "help") return sendMessage(chatId, helpText(), { reply_markup: mainKeyboard() });

  const buyMatch = /^buy:(7|30|life)$/.exec(data);
  if (buyMatch) return sendInvoiceForPlan(db, chatId, from.id, buyMatch[1]);

  const confirmMatch = /^confirm_test:(7|30|life)$/.exec(data);
  if (confirmMatch) return confirmTestPurchase(db, chatId, from.id, confirmMatch[1]);
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
    if (botUsername && botUsername.toLowerCase() !== OFFICIAL_BOT_USERNAME.toLowerCase()) {
      console.warn(
        `[telegram] ВНИМАНИЕ: TELEGRAM_BOT_TOKEN указывает на @${botUsername}, ` +
        `а не на официального бота @${OFFICIAL_BOT_USERNAME}. Проверьте .env, ` +
        `иначе кнопки оплаты в WebApp будут открывать не того бота.`
      );
    }
    await telegramApi("setMyCommands", { commands: [
      { command: "start", description: "Открыть главное меню" },
      { command: "id", description: "Показать Telegram ID" },
      { command: "give", description: "[Owner] Выдать тестовые звёзды" },
      { command: "help", description: "Помощь" },
    ]});
    console.log(`[telegram] Бот @${botUsername} запущен`);
    console.log(`[telegram] Owner ID: ${OWNER_TELEGRAM_ID}`);
    pollingLoop(db).catch(error => console.error("[telegram] Polling fatal:", error));
    return { enabled: true, username: botUsername };
  } catch (error) {
    console.error("[telegram] Не удалось запустить бота:", error.message);
    return { enabled: false, username: botUsername };
  }
}

function getPlans() { return Object.values(PLANS).map(plan => ({ ...plan })); }
function createLinkToken() { return crypto.randomBytes(24).toString("base64url"); }
function getWebAppUrl() { return WEBAPP_URL; }

module.exports = {
  PLANS,
  startTelegramBot,
  getBotUsername,
  createLinkToken,
  getPlans,
  getWebAppUrl,
  getTelegramUserBalance,
  addTestStars,
  isOwner
};
