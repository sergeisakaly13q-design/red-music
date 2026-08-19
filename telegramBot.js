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
  return { telegram_id: telegramIdStr, test_stars: 0, real_stars: 0, earned_stars: 0 };
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
  const totalStars = (balance.test_stars || 0) + (balance.real_stars || 0) + (balance.earned_stars || 0);
  if (totalStars < amount) {
    return { success: false, message: `Недостаточно звёзд. Требуется: ${amount}, у вас есть: ${totalStars}` };
  }
  const telegramIdStr = String(telegramId);
  let remaining = amount;
  try {
    if ((balance.real_stars || 0) >= remaining) {
      db.prepare(`
        UPDATE telegram_user_balance
        SET real_stars = real_stars - ?, updated_at = datetime('now')
        WHERE telegram_id = ?
      `).run(remaining, telegramIdStr);
    } else {
      remaining -= (balance.real_stars || 0);
      const earned = Math.min(balance.earned_stars || 0, remaining);
      if (earned > 0) {
        db.prepare(`
          UPDATE telegram_user_balance
          SET real_stars = 0, earned_stars = earned_stars - ?, updated_at = datetime('now')
          WHERE telegram_id = ?
        `).run(earned, telegramIdStr);
        remaining -= earned;
      } else {
        db.prepare(`
          UPDATE telegram_user_balance
          SET real_stars = 0, updated_at = datetime('now')
          WHERE telegram_id = ?
        `).run(telegramIdStr);
      }
      if (remaining > 0) {
        db.prepare(`
          UPDATE telegram_user_balance
          SET test_stars = test_stars - ?, updated_at = datetime('now')
          WHERE telegram_id = ?
        `).run(remaining, telegramIdStr);
      }
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
    [{ text: "🏆 Достижения", callback_data: "achievements:1" }],
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


const ACHIEVEMENT_MAX_HOURS = 6767;
const ACHIEVEMENT_STEP_MINUTES = 60;
const ACHIEVEMENT_STARS = 10;
const ACHIEVEMENT_PAGE_SIZE = 10;

async function syncListeningAchievements(db, appUserId) {
  const linked = db.prepare(`
    SELECT telegram_id FROM telegram_users
    WHERE app_user_id = ?
    ORDER BY last_seen_at DESC
    LIMIT 1
  `).get(Number(appUserId));
  if (!linked) return 0;

  const stats = db.prepare(`
    SELECT completed_seconds FROM listening_reward_stats WHERE user_id = ?
  `).get(Number(appUserId));
  const completedHours = Math.min(
    ACHIEVEMENT_MAX_HOURS,
    Math.floor(Math.max(0, Number(stats?.completed_seconds || 0)) / 3600)
  );
  if (completedHours < 1) return 0;

  const telegramId = String(linked.telegram_id);
  const last = db.prepare(`
    SELECT MAX(milestone_hour) AS max_hour
    FROM telegram_achievement_rewards
    WHERE telegram_id = ?
  `).get(telegramId);
  const alreadyAwarded = Number(last?.max_hour || 0);

  let awarded = 0;
  const transaction = db.transaction(() => {
    for (let hour = alreadyAwarded + 1; hour <= completedHours; hour += 1) {
      const result = db.prepare(`
        INSERT OR IGNORE INTO telegram_achievement_rewards
          (telegram_id, milestone_hour, stars)
        VALUES (?, ?, ?)
      `).run(telegramId, hour, ACHIEVEMENT_STARS);

      if (result.changes) {
        db.prepare(`
          UPDATE telegram_user_balance
          SET earned_stars = earned_stars + ?, updated_at = datetime('now')
          WHERE telegram_id = ?
        `).run(ACHIEVEMENT_STARS, telegramId);
        awarded += ACHIEVEMENT_STARS;
      }
    }
  });
  transaction();

  if (awarded > 0) {
    try {
      await sendMessage(
        telegramId,
        `<b>🏆 Достижение получено!</b>\n\n` +
        `Вы прослушали <b>${completedHours} ч</b> в Red Music.\n` +
        `Заработано: <b>⭐ ${awarded}</b>\n\n` +
        `Эти звёзды можно использовать для покупки VIP.`
      );
    } catch (e) {
      console.error("[telegram] Не удалось отправить уведомление о достижении:", e.message);
    }
  }

  return awarded;
}

async function sendAchievements(db, chatId, telegramId, page = 1) {
  const telegramIdStr = String(telegramId);
  const linked = getLinkedAppUser(db, telegramIdStr);

  if (!linked) {
    await sendMessage(chatId,
      `<b>🏆 Достижения Red Music</b>\n\n` +
      `Чтобы получать ⭐ за прослушивание, сначала привяжите Telegram к аккаунту Red Music.\n\n` +
      `После привязки приложение будет считать только реально прослушанные треки.`,
      { reply_markup: { inline_keyboard: [
        [{ text: "💎 Тарифы", callback_data: "plans" }],
        [{ text: "↩️ Главное меню", callback_data: "home" }],
      ]}});
    return;
  }

  await syncListeningAchievements(db, linked.id);

  const stats = db.prepare(`
    SELECT completed_seconds FROM listening_reward_stats WHERE user_id = ?
  `).get(linked.id);
  const completedSeconds = Math.max(0, Number(stats?.completed_seconds || 0));
  const completedMinutes = Math.floor(completedSeconds / 60);
  const completedHours = Math.min(ACHIEVEMENT_MAX_HOURS, Math.floor(completedSeconds / 3600));

  const totalPages = Math.ceil(ACHIEVEMENT_MAX_HOURS / ACHIEVEMENT_PAGE_SIZE);
  const safePage = Math.max(1, Math.min(totalPages, Number(page) || 1));
  const first = (safePage - 1) * ACHIEVEMENT_PAGE_SIZE + 1;
  const last = Math.min(ACHIEVEMENT_MAX_HOURS, first + ACHIEVEMENT_PAGE_SIZE - 1);

  const rewards = db.prepare(`
    SELECT milestone_hour FROM telegram_achievement_rewards
    WHERE telegram_id = ? AND milestone_hour BETWEEN ? AND ?
  `).all(telegramIdStr, first, last);
  const rewarded = new Set(rewards.map(x => Number(x.milestone_hour)));

  const balance = getTelegramUserBalance(db, telegramIdStr);
  const rows = [];
  for (let hour = first; hour <= last; hour += 1) {
    const minutes = hour * ACHIEVEMENT_STEP_MINUTES;
    const done = rewarded.has(hour);
    const current = completedMinutes >= minutes;
    rows.push(
      `${done ? "✅" : current ? "🎯" : "🔒"} <b>${minutes.toLocaleString("ru-RU")} мин</b> (${hour.toLocaleString("ru-RU")} ч) — ⭐ ${ACHIEVEMENT_STARS}`
    );
  }

  const buttons = [];
  if (safePage > 1) buttons.push({ text: "⬅️ Назад", callback_data: `ach:${safePage - 1}` });
  if (safePage < totalPages) buttons.push({ text: "Вперёд ➡️", callback_data: `ach:${safePage + 1}` });
  const keyboard = [];
  if (buttons.length) keyboard.push(buttons);
  keyboard.push([{ text: "👤 Профиль", callback_data: "profile" }]);
  keyboard.push([{ text: "↩️ Главное меню", callback_data: "home" }]);

  await sendMessage(chatId,
    `<b>🏆 Достижения</b>\n\n` +
    `<b>Прослушано:</b> ${completedMinutes.toLocaleString("ru-RU")} мин (${completedHours.toLocaleString("ru-RU")} ч)\n` +
    `<b>Заработано за достижения:</b> ⭐ ${balance.earned_stars || 0}\n` +
    `<b>Максимум:</b> 6 767 ч\n\n` +
    rows.join("\n") +
    `\n\n<b>Страница ${safePage}/${totalPages}</b>\n` +
    `<i>Каждые полные 60 минут прослушивания = ⭐ 10.</i>`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function sendProfile(db, chatId, telegramId) {
  const balance = getTelegramUserBalance(db, telegramId);
  const totalStars = (balance.test_stars || 0) + (balance.real_stars || 0) + (balance.earned_stars || 0);
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
    `  └ Заработано за достижения: ⭐ ${balance.earned_stars || 0}\n` +
    `  └ Реальных: ⭐ ${balance.real_stars || 0}\n\n` +
    `<b>📊 Статус подписки:</b> ${hasVip ? "🟢 VIP активна" : "⚪ Обычный пользователь"}\n` +
    (linked && linked.vip_until ? `<b>Окончание:</b> ${escapeHtml(fmtDate(linked.vip_until))}\n` : "") +
    `\n<b>Выберите действие:</b>`,
    { reply_markup: { inline_keyboard: [
      [{ text: "🎵 Купить подписку", callback_data: "buy_now" }],
      [{ text: "🏆 Достижения", callback_data: "achievements:1" }],
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
  const totalStars = (balance.test_stars || 0) + (balance.real_stars || 0) + (balance.earned_stars || 0);
  
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
    purchaseTime: Date.now(),
    isTestPurchase: true
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
  const telegramIdStr = String(telegramId);
  const state = userStates.get(telegramIdStr);
  if (!state || !state.waitingForAppUserId) {
    await sendMessage(chatId, `<b>❌ Ошибка</b>\n\nСначала купите подписку.`);
    return;
  }

  if (Date.now() - state.purchaseTime > 30 * 60 * 1000) {
    userStates.delete(telegramIdStr);
    await sendMessage(chatId, `<b>❌ Время истекло</b>\n\nПопробуйте купить подписку снова.`);
    return;
  }

  const appUserId = parseInt(String(userInput).trim(), 10);
  if (!Number.isInteger(appUserId) || appUserId <= 0) {
    await sendMessage(chatId,
      `<b>❌ Неверный ID</b>\n\n` +
      `ID аккаунта Red Music должен быть положительным числом.\n\n` +
      `Пример: <code>123</code>`);
    return;
  }

  const appUser = db.prepare(
    "SELECT id, username, display_name FROM users WHERE id = ?"
  ).get(appUserId);

  if (!appUser) {
    await sendMessage(chatId,
      `<b>❌ Аккаунт не найден</b>\n\n` +
      `Пользователь с ID <code>${appUserId}</code> не найден в Red Music.\n\n` +
      `Проверьте ID в профиле приложения и отправьте его ещё раз.`);
    return;
  }

  const existingLink = db.prepare(`
    SELECT telegram_id FROM telegram_users
    WHERE app_user_id = ? AND telegram_id != ?
    LIMIT 1
  `).get(appUserId, telegramIdStr);

  if (existingLink) {
    await sendMessage(chatId,
      `<b>❌ Аккаунт уже привязан</b>\n\n` +
      `Этот App User ID уже связан с другим Telegram-аккаунтом. ` +
      `Для защиты достижений один аккаунт Red Music может быть привязан только к одному Telegram.`);
    return;
  }

  const plan = state.plan;

  try {
    const expiresAt = activateAppSubscription(db, appUserId, plan);
    const ending = expiresAt ? fmtDate(expiresAt) : "Без ограничения";

    // If this was a real Telegram Stars purchase, attach that already-paid
    // purchase to the selected Red Music account only now.
    if (state.purchaseId) {
      db.prepare(`
        UPDATE telegram_purchases
        SET app_user_id = ?, expires_at = ?
        WHERE id = ? AND telegram_id = ? AND status = 'paid'
      `).run(appUserId, expiresAt, state.purchaseId, telegramIdStr);
    }

    db.prepare(`
      UPDATE telegram_users
      SET app_user_id = ?, pending_link_token = NULL, last_seen_at = datetime('now')
      WHERE telegram_id = ?
    `).run(appUserId, telegramIdStr);

    if (state.linkToken) {
      db.prepare(
        "UPDATE telegram_link_tokens SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL"
      ).run(state.linkToken);
    }

    userStates.delete(telegramIdStr);

    await sendMessage(chatId,
      `<b>✅ VIP активирован!</b>\n\n` +
      `<b>Аккаунт Red Music:</b> ${escapeHtml(appUser.display_name || appUser.username)}\n` +
      `<b>App User ID:</b> <code>${appUserId}</code>\n` +
      `<b>Тариф:</b> ${escapeHtml(plan.name)}\n` +
      `<b>Оплачено:</b> ⭐ ${plan.stars}\n` +
      `<b>Окончание:</b> ${escapeHtml(ending)}\n\n` +
      `Откройте Red Music. VIP будет привязан к указанному аккаунту.`,
      { reply_markup: mainKeyboard() });

    const tg = db.prepare(
      "SELECT username FROM telegram_users WHERE telegram_id = ?"
    ).get(telegramIdStr);
    const username = tg?.username ? `@${tg.username}` : "отсутствует";

    await notifyAdmin(
      `<b>✅ VIP активирован</b>\n\n` +
      `<b>Сумма:</b> ⭐ ${plan.stars}${state.isTestPurchase ? " (тестовые)" : ""}\n` +
      `<b>Тариф:</b> ${escapeHtml(plan.name)}\n` +
      `<b>Telegram ID:</b> <code>${escapeHtml(telegramIdStr)}</code>\n` +
      `<b>Username:</b> ${escapeHtml(username)}\n` +
      `<b>App User ID:</b> <code>${appUserId}</code>\n` +
      `<b>Аккаунт Red Music:</b> ${escapeHtml(appUser.display_name || appUser.username)}\n` +
      `<b>Окончание:</b> ${escapeHtml(ending)}`
    );
  } catch (error) {
    console.error("[telegram] Ошибка при активации VIP:", error.stack || error.message);
    await sendMessage(chatId,
      `<b>❌ Не удалось активировать VIP</b>\n\n${escapeHtml(error.message)}`);
  }
}

async function sendSuccessfulPayment(db, message) {
  const payment = message.successful_payment;
  const telegramId = String(message.from.id);
  const payload = String(payment.invoice_payload || "");
  const parts = payload.split("|");
  const plan = planFromCode(parts[1]);

  if (!plan) {
    console.error("[telegram] Неизвестный план:", payload);
    await sendMessage(message.chat.id, `<b>❌ Ошибка платежа</b>\n\nНе удалось определить тариф.`);
    return;
  }

  const linkToken = String(parts[2] || "");
  const chargeId = String(payment.telegram_payment_charge_id || "");

  const already = db.prepare(
    "SELECT id, app_user_id FROM telegram_purchases WHERE telegram_payment_charge_id = ?"
  ).get(chargeId);

  if (already) {
    // Do not charge/activate twice. If the user still has to link an account,
    // restore the waiting state so they can finish the purchase.
    if (!already.app_user_id) {
      userStates.set(telegramId, {
        waitingForAppUserId: true,
        plan,
        purchaseId: Number(already.id),
        linkToken: linkToken || null,
        purchaseTime: Date.now(),
        isTestPurchase: false
      });
      await sendMessage(message.chat.id,
        `<b>⭐ Оплата уже получена</b>\n\n` +
        `Теперь отправьте <b>App User ID</b> аккаунта Red Music, чтобы активировать VIP.\n\n` +
        `Пример: <code>123</code>`);
    }
    return;
  }

  const purchaseInfo = db.prepare(`
    INSERT INTO telegram_purchases
      (telegram_id, app_user_id, plan_code, plan_name, stars, duration_days,
       purchased_at, expires_at, telegram_payment_charge_id, invoice_payload, status)
    VALUES (?, NULL, ?, ?, ?, ?, datetime('now'), NULL, ?, ?, 'paid')
  `).run(
    telegramId,
    plan.code,
    plan.name,
    plan.stars,
    plan.days,
    chargeId,
    payload
  );

  const purchaseId = Number(purchaseInfo.lastInsertRowid);

  // Payment is confirmed by Telegram, but VIP is deliberately NOT assigned
  // until the buyer enters the Red Music account ID.
  userStates.set(telegramId, {
    waitingForAppUserId: true,
    plan,
    purchaseId,
    linkToken: linkToken || null,
    purchaseTime: Date.now(),
    isTestPurchase: false
  });

  const tg = db.prepare(
    "SELECT username FROM telegram_users WHERE telegram_id = ?"
  ).get(telegramId);
  const username = tg?.username ? `@${tg.username}` : "отсутствует";

  await notifyAdmin(
    `<b>💳 Оплата Telegram Stars подтверждена</b>\n\n` +
    `<b>Сумма:</b> ⭐ ${plan.stars}\n` +
    `<b>Тариф:</b> ${escapeHtml(plan.name)}\n` +
    `<b>Telegram ID:</b> <code>${escapeHtml(telegramId)}</code>\n` +
    `<b>Username:</b> ${escapeHtml(username)}\n` +
    `<b>App User ID:</b> ожидается от пользователя`
  );

  await sendMessage(message.chat.id,
    `<b>✅ Оплата подтверждена!</b>\n\n` +
    `<b>Тариф:</b> ${escapeHtml(plan.name)}\n` +
    `<b>Оплачено:</b> ⭐ ${plan.stars}\n\n` +
    `Теперь отправьте <b>App User ID</b> вашего аккаунта Red Music.\n\n` +
    `Найти его можно в профиле приложения.\n` +
    `Пример: <code>123</code>\n\n` +
    `<i>После проверки ID VIP будет автоматически выдан этому аккаунту.</i>`);
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

  if (/^\/achievements\b/i.test(text)) {
    await sendAchievements(db, message.chat.id, message.from.id, 1);
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
  const achievementMatch = /^ach:(\d+)$/.exec(data);
  if (achievementMatch) return sendAchievements(db, chatId, from.id, Number(achievementMatch[1]));

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
      { command: "achievements", description: "Достижения и звёзды за прослушивание" },
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
  isOwner,
  syncListeningAchievements
};
