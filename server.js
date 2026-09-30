import express from 'express';
import { WebSocketServer } from 'ws';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// Serveur "relais" sans état : il écoute TikTok pour chaque appareil connecté
// et lui renvoie les cadeaux. Les sons et règles restent dans le navigateur.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MAX_CLIENTS = 30;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  if (wss.clients.size > MAX_CLIENTS) return ws.close(1013, 'Serveur plein');
  let conn = null;
  const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const status = (state, message = '') => send({ type: 'status', state, message });

  const stop = () => {
    if (conn) { try { conn.disconnect(); } catch {} conn = null; }
  };

  async function start(username) {
    stop();
    username = String(username || '').trim().replace(/^@/, '').slice(0, 40);
    if (!username) return status('error', 'Entre ton pseudo TikTok');
    status('connecting', `Connexion à @${username}…`);
    const c = new TikTokLiveConnection(username);
    conn = c;

    c.on(WebcastEvent.GIFT, data => {
      const d = data.giftDetails || {};
      const streakable = d.giftType === 1;
      if (streakable && !data.repeatEnd) return; // on attend la fin de la série
      send({
        type: 'gift',
        gift: d.giftName || data.giftName || 'Cadeau',
        diamonds: (d.diamondCount || data.diamondCount || 0) * (streakable ? data.repeatCount || 1 : 1),
        user: data.user?.nickname || data.user?.uniqueId || '???',
        count: data.repeatCount || 1
      });
    });
    c.on(WebcastEvent.STREAM_END, () => status('disconnected', 'Le live est terminé'));
    c.on(WebcastEvent.DISCONNECTED, () => { if (conn === c) status('disconnected', 'Déconnecté'); });
    c.on(WebcastEvent.ERROR, e => console.error('TikTok error:', e?.message || e));

    try {
      await c.connect();
      if (conn === c) status('connected', `Connecté au live de @${username}`);
    } catch (e) {
      if (conn === c) conn = null;
      status('error', String(e?.message || e).slice(0, 200));
    }
  }

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'connect') start(m.username);
    else if (m.type === 'disconnect') { stop(); status('disconnected'); }
  });
  ws.on('close', stop);
  ws.on('error', stop);
});

// Ping régulier pour garder la connexion vivante derrière les proxys d'hébergement
setInterval(() => { for (const c of wss.clients) if (c.readyState === 1) c.ping(); }, 25000);

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\nTikTok Soundboard prêt !');
  console.log(`   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`   http://${ip}:${PORT}  (même Wi-Fi)`);
});
