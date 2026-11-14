// Email sending for Tender Gateway.
// Email is the only channel this site uses to talk to people.
//
// Set these environment variables on Railway to turn email on:
//   SMTP_HOST      e.g. smtp.your-mail-host.com
//   SMTP_PORT      e.g. 465
//   SMTP_USER      the mailbox login
//   SMTP_PASS      the mailbox password
//   MAIL_FROM      the "from" address shown to people, e.g. "Tender Gateway <tenders@yourdomain>"
//   ADMIN_EMAIL    where new-request alerts are sent (optional)
//
// If SMTP is not configured, the app still works: it just logs the email
// instead of sending it, so nothing breaks before you set it up.

const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.MAIL_FROM || (user ? `Tender Gateway <${user}>` : 'Tender Gateway <no-reply@localhost>');

let transport = null;
if (host && user && pass) {
  transport = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass },
  });
  console.log('Email is configured; messages will be sent through', host);
} else {
  console.log('Email is not configured yet; messages will be logged, not sent.');
}

async function send(to, subject, text) {
  if (!to) return;
  if (!transport) {
    console.log(`[email not sent - SMTP off] to=${to} subject="${subject}"`);
    return;
  }
  try {
    await transport.sendMail({ from, to, subject, text });
  } catch (e) {
    console.error('Email failed to send:', e.message);
  }
}

const SITE = process.env.SITE_URL || '';
const link = (reqId) => SITE ? `${SITE.replace(/\/$/, '')}/#request=${reqId}` : `(your request reference: ${reqId})`;

async function notifyNewRequest(adminEmail, req) {
  await send(adminEmail, `New consultancy request: ${req.company}`,
    `A new consultancy request has arrived.\n\n` +
    `Company: ${req.company} (${req.country})\n` +
    `Contact: ${req.contactName} <${req.email}>\n` +
    `Tender: ${req.tenderRef} - ${req.tenderTitle}\n` +
    `Issuer: ${req.tenderOrg}\n` +
    `Support level: ${req.level}\n\n` +
    `Open the Admin page to send a quote.`);
}

async function confirmToClient(req) {
  await send(req.email, `We received your consultancy request`,
    `Hello ${req.contactName},\n\n` +
    `Thank you for your consultancy request for:\n${req.tenderRef} - ${req.tenderTitle}\n\n` +
    `Our team will review it and email you a fixed-fee quote, usually within one business day.\n\n` +
    `You can check the status of your request here:\n${link(req.id)}\n\n` +
    `Tender Gateway`);
}

async function quoteToClient(req) {
  const q = req.quote || {};
  await send(req.email, `Your consultancy quote is ready`,
    `Hello ${req.contactName},\n\n` +
    `We have prepared a quote for your request:\n${req.tenderRef} - ${req.tenderTitle}\n\n` +
    `Fee: ${q.currency || 'USD'} ${q.fee}\n` +
    `Turnaround: ${q.turnaround}\n` +
    `Scope: ${q.scope}\n` +
    (q.note ? `Note: ${q.note}\n` : '') +
    `\nTo accept or decline, open:\n${link(req.id)}\n\n` +
    `No fee is charged until you accept.\n\nTender Gateway`);
}

module.exports = { send, notifyNewRequest, confirmToClient, quoteToClient };
