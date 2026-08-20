const net = require("net");
const tls = require("tls");

function waitForResponse(socket, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("SMTP timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    }
    function onError(err) { cleanup(); reject(err); }
    function onClose() { cleanup(); reject(new Error("SMTP connection closed")); }
    function onData(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (/^\d{3} /.test(line)) {
          cleanup();
          const code = Number(line.slice(0, 3));
          if (code >= 400) reject(new Error(`SMTP ${code}: ${line.slice(4)}`));
          else resolve(line);
          return;
        }
      }
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function write(socket, command) {
  socket.write(command + "\r\n");
}

function dotStuff(value) {
  return String(value).replace(/^\./gm, "..");
}

async function sendVerificationEmail({ to, code, expiresMinutes }) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");
  const from = String(process.env.SMTP_FROM || user).trim();
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? "true" : "false")).toLowerCase() === "true";

  if (!host || !user || !pass || !from) {
    throw new Error("SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM.");
  }

  let socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SMTP connection timeout")), 15000);
    socket.once("secureConnect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect", () => {
      if (!secure) { clearTimeout(timer); resolve(); }
    });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
  });

  try {
    await waitForResponse(socket);
    write(socket, `EHLO redmusic`);
    await waitForResponse(socket);

    if (!secure) {
      write(socket, "STARTTLS");
      await waitForResponse(socket);
      await new Promise((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
        socket = tls.connect({ socket, servername: host, rejectUnauthorized: true });
      });
      write(socket, "EHLO redmusic");
      await waitForResponse(socket);
    }

    write(socket, "AUTH LOGIN");
    await waitForResponse(socket);
    write(socket, Buffer.from(user).toString("base64"));
    await waitForResponse(socket);
    write(socket, Buffer.from(pass).toString("base64"));
    await waitForResponse(socket);

    write(socket, `MAIL FROM:<${from}>`);
    await waitForResponse(socket);
    write(socket, `RCPT TO:<${to}>`);
    await waitForResponse(socket);
    write(socket, "DATA");
    await waitForResponse(socket);

    const subject = "Red Music — код подтверждения почты";
    const text = `Ваш код подтверждения Red Music: ${code}\n\nКод действителен ${expiresMinutes} минут.\nЕсли вы не регистрировались в Red Music, просто проигнорируйте это письмо.`;
    const headers = [
      `From: Red Music <${from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
    ].join("\r\n");

    socket.write(dotStuff(`${headers}\r\n\r\n${text}\r\n.`) + "\r\n");
    await waitForResponse(socket);
    write(socket, "QUIT");
    try { await waitForResponse(socket, 5000); } catch (_) {}
  } finally {
    socket.end();
  }
}

module.exports = { sendVerificationEmail };
