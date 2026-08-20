const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const BACKUP_SECRET = String(process.env.BACKUP_SECRET || '').trim();
const BACKUP_ENCRYPTION_KEY = String(process.env.BACKUP_ENCRYPTION_KEY || '').trim();
const BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const BACKUP_CHAT_ID = String(
  process.env.BACKUP_TELEGRAM_CHAT_ID ||
  process.env.TELEGRAM_ADMIN_CHAT_ID ||
  process.env.OWNER_TELEGRAM_ID || ''
).trim();

function getDbPath() {
  const storageDir = String(process.env.STORAGE_DIR || path.join(__dirname, 'storage')).trim();
  return String(process.env.SQLITE_PATH || path.join(storageDir, 'data', 'red-music.db')).trim();
}

function requireBackupConfig() {
  if (!BACKUP_SECRET || BACKUP_SECRET.length < 32) {
    throw new Error('BACKUP_SECRET не задан или короче 32 символов.');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(BACKUP_ENCRYPTION_KEY)) {
    throw new Error('BACKUP_ENCRYPTION_KEY должен содержать ровно 64 hex-символа (32 байта).');
  }
  if (!BOT_TOKEN || !BACKUP_CHAT_ID) {
    throw new Error('Для внешней резервной копии нужны TELEGRAM_BOT_TOKEN и BACKUP_TELEGRAM_CHAT_ID (или TELEGRAM_ADMIN_CHAT_ID / OWNER_TELEGRAM_ID).');
  }
}

function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function authorizedBackupRequest(req) {
  const supplied = String(req.get('x-backup-secret') || '').trim();
  return Boolean(supplied) && constantTimeEqual(supplied, BACKUP_SECRET);
}

async function telegramSendDocument(filePath, caption) {
  const form = new FormData();
  form.append('chat_id', BACKUP_CHAT_ID);
  form.append('caption', caption.slice(0, 1024));
  form.append('document', new Blob([await fsp.readFile(filePath)], { type: 'application/octet-stream' }), path.basename(filePath));

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendDocument: ${data.description || `HTTP ${response.status}`}`);
  }
  return data.result;
}

async function createEncryptedBackup(db) {
  requireBackupConfig();

  const dbPath = getDbPath();
  await fsp.access(dbPath, fs.constants.R_OK);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'red-music-backup-'));
  const rawDbPath = path.join(tempDir, 'red-music.db');
  const encryptedPath = path.join(tempDir, `red-music-${new Date().toISOString().replace(/[:.]/g, '-')}.db.enc`);

  try {
    // better-sqlite3's online backup API creates a consistent snapshot even
    // while the application is actively using the database.
    await db.backup(rawDbPath);

    const plain = await fsp.readFile(rawDbPath);
    const key = Buffer.from(BACKUP_ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const header = Buffer.from(JSON.stringify({
      format: 'RED-MUSIC-BACKUP',
      version: 1,
      algorithm: 'aes-256-gcm',
      createdAt: new Date().toISOString(),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      originalFile: 'red-music.db',
    }) + '\n', 'utf8');

    await fsp.writeFile(encryptedPath, Buffer.concat([Buffer.from('RMBK1\n', 'ascii'), header, ciphertext]), { mode: 0o600 });

    const stat = await fsp.stat(encryptedPath);
    const caption = `🔐 Red Music DB backup\nДата: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau' })}\nРазмер: ${(stat.size / 1024 / 1024).toFixed(2)} MB\nФормат: AES-256-GCM`;
    await telegramSendDocument(encryptedPath, caption);

    return { ok: true, fileName: path.basename(encryptedPath), size: stat.size };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function registerBackupRoutes(app, db) {
  app.post('/api/internal/database-backup', async (req, res) => {
    if (!authorizedBackupRequest(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    try {
      const result = await createEncryptedBackup(db);
      console.log(`[backup] Защищённая копия создана и отправлена: ${result.fileName} (${result.size} bytes)`);
      return res.json(result);
    } catch (error) {
      console.error('[backup] Ошибка:', error.stack || error.message);
      return res.status(500).json({ ok: false, error: 'Backup failed' });
    }
  });
}

module.exports = { registerBackupRoutes, createEncryptedBackup, authorizedBackupRequest };
