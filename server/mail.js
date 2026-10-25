/**
 * A small SMTP client (no dependencies) for optional email: STARTTLS or implicit TLS, AUTH PLAIN,
 * one plain-text message per connection. Everything still works without email configured.
 */
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';
import { getSettings } from './db.js';

export const mailConfigured = (s = getSettings()) => !!(s.smtp_host && s.smtp_from);

function reader(socket) {
  let buf = '';
  let waiting = null;
  const lines = [];
  const flush = () => {
    // A reply ends with a line whose 4th character is a space ("250 OK"), after "250-..." continuation lines.
    const idx = lines.findIndex((l) => /^\d{3}( |$)/.test(l));
    if (idx >= 0 && waiting) {
      const reply = lines.splice(0, idx + 1);
      const w = waiting;
      waiting = null;
      w.resolve({ code: Number(reply[reply.length - 1].slice(0, 3)), text: reply.join('\n') });
    }
  };
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
    flush();
  };
  socket.on('data', onData);
  return {
    next: () =>
      new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        flush();
      }),
    detach: () => socket.off('data', onData),
  };
}

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

function message({ from, to, subject, text }) {
  const body = Buffer.from(text.replace(/\r?\n/g, '\r\n'))
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n');
  const domain = (from.split('@')[1] || 'localhost').replace(/>.*$/, '');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Sends one plain-text email with the configured SMTP server. */
export async function sendMail({ to, subject, text }) {
  const s = getSettings();
  if (!mailConfigured(s)) throw new Error('Email is not set up on this site');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new Error('Bad recipient address');
  const host = s.smtp_host;
  const port = Number(s.smtp_port) || (s.smtp_secure === 'tls' ? 465 : 587);
  const timeout = 20000;
  let socket = await new Promise((resolve, reject) => {
    const sock = s.smtp_secure === 'tls' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    sock.setTimeout(timeout, () => sock.destroy(new Error('SMTP server timed out')));
    sock.once(s.smtp_secure === 'tls' ? 'secureConnect' : 'connect', () => resolve(sock));
    sock.once('error', reject);
  });
  let r = reader(socket);
  const send = async (line, ok) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await r.next();
    if (!ok.includes(reply.code)) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'}: ${reply.text.slice(0, 200)}`);
    return reply;
  };
  try {
    await send(null, [220]);
    const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
    let ehlo = await send(`EHLO ${helo}`, [250]);
    if (s.smtp_secure === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('The SMTP server does not offer STARTTLS');
      await send('STARTTLS', [220]);
      r.detach();
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: host }, () => resolve(t));
        t.once('error', reject);
      });
      r = reader(socket);
      ehlo = await send(`EHLO ${helo}`, [250]);
    }
    if (s.smtp_user) {
      await send(`AUTH PLAIN ${Buffer.from(`\0${s.smtp_user}\0${s.smtp_password}`).toString('base64')}`, [235]);
    }
    const fromAddr = (/<([^>]+)>/.exec(s.smtp_from) || [null, s.smtp_from])[1];
    await send(`MAIL FROM:<${fromAddr}>`, [250]);
    await send(`RCPT TO:<${to}>`, [250, 251]);
    await send('DATA', [354]);
    const data = message({ from: s.smtp_from, to, subject, text }).replace(/^\./gm, '..');
    await send(`${data}\r\n.`, [250]);
    socket.write('QUIT\r\n');
  } finally {
    setTimeout(() => socket.destroy(), 500).unref?.();
  }
}
