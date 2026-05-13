// Escape Tsunami For Money — multiplayer authoritative world server.
//
// Phase 1B: server owns coins, tsunamis, and the storm cycle. Clients render
// what the server tells them; coin pickups race through the server so first
// player to claim wins.
//
// Phase 2 (this file): account auth. Username/password registration via HTTP,
// HMAC-signed session token, WebSocket connections must auth before joining.
// Profile (custom + progress) is persisted server-side keyed by userId, so
// players can log in on any device and impersonation is blocked.

const RUNWAY_LEN     = 2000;
const RUNWAY_HALF_W  = 20;
const ZONE_LEN       = 200;
const NUM_ZONES      = 10;
const HILL_START_Z   = 4;
const COIN_RESPAWN_MS = 30_000;   // was 60s — half the wait so cap fills faster
const POWERUP_RESPAWN_MS = 45_000;
const BIG_TREASURE_RESPAWN_MS = 600_000;   // 10 minutes
const BIG_TREASURE_VALUE = 50;
const BIG_TREASURE_Z = -1000;             // boundary of old map / start of new content

const TOKEN_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;   // 90 days
const PRE_AUTH_TIMEOUT_MS = 15_000;                  // drop connections that don't auth quickly
const PBKDF2_ITERATIONS = 100_000;   // Cloudflare Workers caps PBKDF2 at 100k

// Heights kept in sync with the client; server only uses speedMul / width
// for spawn calculations.
const WAVE_TYPES = [
  // Heights tuned so 95%+ of waves are jumpable at Lv 4 jump.
  // Only titan (h=50, needs Lv 15) is "truly uncrossable" and is rare.
  { id:'green',  height:8,  width:14, speedMul:1.0,  weight:22, storm:false },
  { id:'blue',   height:10, width:18, speedMul:1.0,  weight:30, storm:false },
  { id:'red',    height:10, width:14, speedMul:1.8,  weight:18, storm:false },
  { id:'wide',   height:10, width:32, speedMul:0.85, weight:14, storm:false },
  { id:'purple', height:20, width:RUNWAY_HALF_W*2 + 12, speedMul:0.7, weight:4, storm:true },
  { id:'titan',  height:50, width:RUNWAY_HALF_W*2 + 12, speedMul:0.5, weight:1, storm:true },
];
function pickWaveType(stormBoost){
  let total = 0;
  for (const w of WAVE_TYPES) total += w.weight * (stormBoost && w.storm ? 3.5 : 1);
  let r = Math.random() * total;
  for (const w of WAVE_TYPES){
    r -= w.weight * (stormBoost && w.storm ? 3.5 : 1);
    if (r <= 0) return w;
  }
  return WAVE_TYPES[1];
}

// ============================================================
// AUTH HELPERS
// ============================================================

function normalizeUsername(s){
  return String(s || '').trim().toLowerCase();
}
function isValidUsername(s){
  return /^[a-z0-9_]{3,16}$/.test(s);
}
function isValidDisplayName(s){
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t.length >= 1 && t.length <= 16;
}
function isValidPassword(s){
  return typeof s === 'string' && s.length >= 6 && s.length <= 128;
}

function bytesToB64(bytes){
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(b64){
  const padded = b64 + '==='.slice((b64.length + 3) % 4);
  const s = atob(padded);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
function b64url(b64){
  return b64.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlToStd(s){
  return s.replace(/-/g, '+').replace(/_/g, '/');
}

async function hashPassword(password, saltB64){
  const enc = new TextEncoder();
  const salt = saltB64 ? b64ToBytes(b64urlToStd(saltB64))
                       : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return {
    hash: b64url(bytesToB64(new Uint8Array(bits))),
    salt: b64url(bytesToB64(salt)),
  };
}

async function getHmacKey(secret){
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function signToken(userId, secret){
  const payload = { u: userId, e: Date.now() + TOKEN_EXPIRY_MS };
  const payloadB64 = b64url(bytesToB64(new TextEncoder().encode(JSON.stringify(payload))));
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return payloadB64 + '.' + b64url(bytesToB64(new Uint8Array(sig)));
}

async function verifyToken(token, secret){
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  try {
    const key = await getHmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC', key,
      b64ToBytes(b64urlToStd(sigB64)),
      new TextEncoder().encode(payloadB64)
    );
    if (!ok) return null;
    const payloadJson = new TextDecoder().decode(b64ToBytes(b64urlToStd(payloadB64)));
    const payload = JSON.parse(payloadJson);
    if (!payload || !payload.u) return null;
    if (payload.e && payload.e < Date.now()) return null;
    return payload.u;
  } catch (e) {
    return null;
  }
}

function getSecret(room){
  const env = (room && room.env)
           || (room && room.context && room.context.env)
           || (typeof process !== 'undefined' && process.env);
  const s = env && env.AUTH_SECRET;
  if (s) return s;
  console.warn('AUTH_SECRET not set — using insecure default. Run `partykit env push AUTH_SECRET` to fix.');
  return 'dev-insecure-secret-please-replace';
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
function jsonResponse(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default class WorldServer {
  constructor(room){
    this.room = room;
    this.players = new Map();

    // Persistent world (in-memory; resets when the Durable Object hibernates)
    this.coins = [];
    this.waves = [];
    this.nextWaveId = 1;
    this.spawnAccum = 0;
    this.nextSpawnIn = 4;
    this.storm = false;
    this.stormUntil = 0;
    this.stormCooldownUntil = Date.now() + 25_000;

    this.spawnInitialCoins();
    this.powerups = [];
    this.spawnInitialPowerups();
    // Death chests dropped on player death (shared — any player can grab)
    this.chests = [];
    this.nextChestId = 1;
    // Big treasure (one global instance, 10-min respawn, $50)
    this.bigTreasure = {
      available: true,
      respawnAt: 0,
      x: 0, z: BIG_TREASURE_Z,
      value: BIG_TREASURE_VALUE,
    };
    // Plots: 9-tile grid behind the base. ownerId is the userId (stable across
    // sessions) of the owner, or null if for sale.
    this.plots = [];
    {
      let pid = 1;
      for (let row = 0; row < 3; row++){
        for (let col = 0; col < 3; col++){
          this.plots.push({
            id: 'plot' + pid++,
            x: -16 + col * 16,
            z: 28 + row * 18,
            ownerId: null,
            ownerName: '',
            build: { floor:'', walls:'', roof:'', furniture:'', decoration:'' },
          });
        }
      }
    }
    // Leaderboard (persisted in DO storage). New format keys on userId so
    // names can change without losing your slot, and impostors can't poach
    // someone else's row. Old name-keyed format is discarded on load.
    this.scoreboard = [];
    this.scoreboardDirty = false;
    this.scoreboardLastSave = 0;
    if (this.room && this.room.storage){
      try {
        Promise.resolve(this.room.storage.get('scoreboard')).then(s => {
          if (Array.isArray(s) && s.every(e => e && typeof e.userId === 'string')){
            this.scoreboard = s;
            this.broadcast({ type: 'scoreboard_update', scoreboard: this.scoreboard });
          } else if (Array.isArray(s) && s.length > 0){
            // Legacy entries — clear them now that auth is required
            try { this.room.storage.delete('scoreboard'); } catch(e){}
          }
        }).catch(() => {});
        // Also load plot ownership (now keyed by userId so it survives reconnects)
        Promise.resolve(this.room.storage.get('plots')).then(p => {
          if (Array.isArray(p)){
            for (const saved of p){
              const plot = this.plots.find(x => x.id === saved.id);
              if (plot && saved.ownerId){
                plot.ownerId = saved.ownerId;
                plot.ownerName = saved.ownerName || '';
                plot.build = saved.build || plot.build;
              }
            }
          }
        }).catch(() => {});
      } catch(e) {}
    }
    this.plotsDirty = false;
    this.plotsLastSave = 0;
    this.lastTick = Date.now();
    this.tickHandle = setInterval(() => this.tick(), 50);
  }

  // ============================================================
  // HTTP: register / login / me
  // ============================================================
  async onRequest(req){
    try {
      return await this._onRequest(req);
    } catch (e) {
      console.error('[onRequest crash]', e && (e.stack || e.message || e));
      return jsonResponse({
        error: 'server_crash',
        message: String((e && e.message) || e || 'unknown'),
      }, 500);
    }
  }
  async _onRequest(req){
    if (req.method === 'OPTIONS'){
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    const secret = getSecret(this.room);

    if (last === 'register' && req.method === 'POST'){
      let body;
      try { body = await req.json(); }
      catch(e){ return jsonResponse({ error:'bad_json', message:'資料格式錯誤' }, 400); }
      const username = normalizeUsername(body.username);
      const rawDisplay = String(body.displayName || body.username || '').trim();
      const displayName = rawDisplay.slice(0, 16);
      const password = String(body.password || '');
      if (!isValidUsername(username))
        return jsonResponse({ error:'username_invalid', message:'帳號只能用 3-16 個英數字或底線' }, 400);
      if (!isValidDisplayName(displayName))
        return jsonResponse({ error:'displayname_invalid', message:'顯示名稱要 1-16 字' }, 400);
      if (!isValidPassword(password))
        return jsonResponse({ error:'password_invalid', message:'密碼至少 6 字' }, 400);

      const existing = await this.room.storage.get('user:' + username);
      if (existing)
        return jsonResponse({ error:'username_taken', message:'這個帳號已被註冊' }, 409);

      const { hash, salt } = await hashPassword(password);
      const userData = {
        username, displayName, hash, salt,
        createdAt: Date.now(),
        profile: null,
      };
      await this.room.storage.put('user:' + username, userData);
      const token = await signToken(username, secret);
      return jsonResponse({ ok:true, token, username, displayName });
    }

    if (last === 'login' && req.method === 'POST'){
      let body;
      try { body = await req.json(); }
      catch(e){ return jsonResponse({ error:'bad_json', message:'資料格式錯誤' }, 400); }
      const username = normalizeUsername(body.username);
      const password = String(body.password || '');
      if (!username || !password)
        return jsonResponse({ error:'missing', message:'請輸入帳號和密碼' }, 400);
      const user = await this.room.storage.get('user:' + username);
      if (!user)
        return jsonResponse({ error:'bad_credentials', message:'帳號或密碼錯誤' }, 401);
      const { hash } = await hashPassword(password, user.salt);
      if (hash !== user.hash)
        return jsonResponse({ error:'bad_credentials', message:'帳號或密碼錯誤' }, 401);
      const token = await signToken(username, secret);
      return jsonResponse({ ok:true, token, username, displayName: user.displayName });
    }

    if (last === 'me' && req.method === 'GET'){
      const auth = req.headers.get('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const userId = await verifyToken(token, secret);
      if (!userId) return jsonResponse({ error:'bad_token' }, 401);
      const user = await this.room.storage.get('user:' + userId);
      if (!user) return jsonResponse({ error:'no_user' }, 404);
      return jsonResponse({
        ok: true, username: user.username, displayName: user.displayName,
        profile: user.profile || null,
      });
    }

    return jsonResponse({ error:'not_found' }, 404);
  }

  // ============================================================
  // Scoreboard
  // ============================================================
  sortAndBroadcastScoreboard(){
    this.scoreboard.sort((a, b) => b.maxDist - a.maxDist);
    this.scoreboard = this.scoreboard.slice(0, 20);
    this.scoreboardDirty = true;
    this.broadcast({ type: 'scoreboard_update', scoreboard: this.scoreboard });
  }
  recordScore(userId, displayName, dist){
    if (!userId || dist <= 0) return;
    const existing = this.scoreboard.find(s => s.userId === userId);
    if (existing){
      existing.displayName = displayName;
      if (dist > existing.maxDist){
        existing.maxDist = dist;
        existing.when = Date.now();
        this.sortAndBroadcastScoreboard();
      }
    } else {
      this.scoreboard.push({ userId, displayName, maxDist: dist, when: Date.now() });
      this.sortAndBroadcastScoreboard();
    }
  }

  spawnInitialPowerups(){
    let id = 1;
    const TYPES = ['speed', 'jump', 'magnet'];
    for (let zone = 0; zone < NUM_ZONES; zone++){
      const zStart = -zone * ZONE_LEN - 30;
      const zEnd   = -(zone + 1) * ZONE_LEN + 20;
      const count  = 1 + (zone >= 2 ? 1 : 0);
      for (let i = 0; i < count; i++){
        this.powerups.push({
          id: id++,
          type: TYPES[Math.floor(Math.random() * TYPES.length)],
          x: (Math.random() * 2 - 1) * (RUNWAY_HALF_W - 3),
          z: zStart - Math.random() * (zStart - zEnd),
          available: true,
          respawnAt: 0,
        });
      }
    }
  }

  spawnInitialCoins(){
    let id = 1;
    for (let zone = 0; zone < NUM_ZONES; zone++){
      const zStart = -(zone) * ZONE_LEN - 15;
      const zEnd   = -(zone + 1) * ZONE_LEN + 5;
      // Front-zone bonus so early players have enough cash for first upgrades.
      // zone 0:32 / 1:38 / 2:44 / 3:50 / 4:56 / ... / 9:106
      const count  = 16 + zone * 10 + Math.max(0, 4 - zone) * 4;
      const value  = 1 + zone;
      for (let i = 0; i < count; i++){
        this.coins.push({
          id: id++,
          x: (Math.random() * 2 - 1) * (RUNWAY_HALF_W - 1),
          z: zStart - Math.random() * (zStart - zEnd),
          value,
          available: true,
          respawnAt: 0,
        });
      }
    }
  }

  tick(){
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    // Coin respawn
    for (const c of this.coins){
      if (!c.available && c.respawnAt && now >= c.respawnAt){
        c.available = true;
        c.respawnAt = 0;
        this.broadcast({ type: 'coin_respawn', id: c.id });
      }
    }
    // Big treasure respawn
    if (!this.bigTreasure.available && this.bigTreasure.respawnAt && now >= this.bigTreasure.respawnAt){
      this.bigTreasure.available = true;
      this.bigTreasure.respawnAt = 0;
      this.broadcast({
        type: 'big_treasure_spawn',
        x: this.bigTreasure.x, z: this.bigTreasure.z, value: this.bigTreasure.value,
      });
    }

    // Powerup respawn (re-randomize type each respawn so distribution mixes)
    for (const p of this.powerups){
      if (!p.available && p.respawnAt && now >= p.respawnAt){
        const TYPES = ['speed', 'jump', 'magnet'];
        p.type = TYPES[Math.floor(Math.random() * TYPES.length)];
        p.available = true;
        p.respawnAt = 0;
        this.broadcast({ type: 'powerup_respawn', id: p.id, ptype: p.type });
      }
    }

    // Storm phase machine
    if (!this.storm && now >= this.stormCooldownUntil && Math.random() < dt * 0.025){
      this.storm = true;
      this.stormUntil = now + (14 + Math.random() * 8) * 1000;
      this.broadcast({ type: 'storm_start' });
    }
    if (this.storm && now > this.stormUntil){
      this.storm = false;
      this.stormCooldownUntil = now + (30 + Math.random() * 50) * 1000;
      this.broadcast({ type: 'storm_end' });
    }

    // Wave spawning (only if at least one authed player is in danger zone)
    const authedPlayers = Array.from(this.players.values()).filter(p => p.authed);
    if (authedPlayers.length > 0){
      this.spawnAccum += dt;
      if (this.spawnAccum > this.nextSpawnIn){
        this.spawnAccum = 0;
        if (this.storm){
          this.nextSpawnIn = 0.8 + Math.random() * 1.6;
        } else {
          const r = Math.random();
          if (r < 0.6)       this.nextSpawnIn = 3 + Math.random() * 3;
          else if (r < 0.85) this.nextSpawnIn = 1.5 + Math.random();
          else               this.nextSpawnIn = 8 + Math.random() * 8;
        }
        this.nextSpawnIn *= 0.81;  // +10% over previous +10% (cumulative ×0.81)

        // Use the deepest authed player to set difficulty
        let minZ = 8;
        for (const p of authedPlayers) if (p.z < minZ) minZ = p.z;

        // Only actually spawn if at least one player has crossed safety line
        if (minZ < 5){
          const wt = pickWaveType(this.storm);
          const fromZ = -RUNWAY_LEN + 5;
          const dist = minZ - fromZ;
          const depthFactor = Math.min(1, Math.max(0, -minZ) / RUNWAY_LEN);
          const approach = (10 - depthFactor * 4) / wt.speedMul;
          const speed = Math.max(0.30 * wt.speedMul, dist / approach / 60);

          const partial = wt.width < RUNWAY_HALF_W * 1.7;
          const baseX = partial ? (Math.random() * 2 - 1) * (RUNWAY_HALF_W - wt.width/2 - 1) : 0;
          const lateralAmp = partial ? Math.min(RUNWAY_HALF_W - wt.width/2 - 1, 4 + Math.random() * 6) : 0;

          const wave = {
            id: this.nextWaveId++,
            waveTypeId: wt.id,
            speed,
            fromZ,
            baseX,
            lateralAmp,
            lateralPhase: Math.random() * Math.PI * 2,
            lateralFreq: 0.5 + Math.random() * 1.0,
            spawnTime: now,
          };
          this.waves.push(wave);
          this.broadcast({ type: 'wave_spawn', wave });
        }
      }
    }

    // Persist scoreboard at most once every 5s while there are pending changes
    if (this.scoreboardDirty && (now - this.scoreboardLastSave) > 5000){
      this.scoreboardLastSave = now;
      this.scoreboardDirty = false;
      if (this.room && this.room.storage){
        try { Promise.resolve(this.room.storage.put('scoreboard', this.scoreboard)).catch(()=>{}); } catch(e){}
      }
    }
    // Persist plot ownership similarly
    if (this.plotsDirty && (now - this.plotsLastSave) > 5000){
      this.plotsLastSave = now;
      this.plotsDirty = false;
      if (this.room && this.room.storage){
        try {
          const snap = this.plots.map(p => ({
            id: p.id, ownerId: p.ownerId, ownerName: p.ownerName, build: p.build,
          }));
          Promise.resolve(this.room.storage.put('plots', snap)).catch(()=>{});
        } catch(e){}
      }
    }

    // Wave removal once past hill base
    for (let i = this.waves.length - 1; i >= 0; i--){
      const w = this.waves[i];
      const elapsed = (now - w.spawnTime) / 1000;
      const z = w.fromZ + w.speed * 60 * elapsed;
      if (z > HILL_START_Z){
        this.waves.splice(i, 1);
        this.broadcast({ type: 'wave_remove', id: w.id });
      }
    }
  }

  broadcast(obj, except){
    this.room.broadcast(JSON.stringify(obj), except || []);
  }

  onConnect(conn){
    // Connection starts un-authed. We tell the client we need auth, then
    // wait for an `auth` message with a valid token before adding them to
    // the world. Anything else sent before that is ignored.
    const player = {
      id: conn.id,
      userId: null, displayName: null,
      name: '???', custom: null,
      x: 0, y: 0, z: 8, ry: 0, moving: false, inPit: false,
      authed: false,
    };
    this.players.set(conn.id, player);

    try { conn.send(JSON.stringify({ type: 'auth_required' })); } catch(e){}

    setTimeout(() => {
      const p = this.players.get(conn.id);
      if (p && !p.authed){
        try { conn.send(JSON.stringify({ type: 'auth_timeout' })); } catch(e){}
        try { conn.close(); } catch(e){}
        this.players.delete(conn.id);
      }
    }, PRE_AUTH_TIMEOUT_MS);
  }

  async handleAuth(conn, msg){
    const secret = getSecret(this.room);
    const userId = await verifyToken(msg.token, secret);
    if (!userId){
      try { conn.send(JSON.stringify({ type: 'auth_failed', reason: 'bad_token' })); } catch(e){}
      try { conn.close(); } catch(e){}
      return false;
    }
    const user = await this.room.storage.get('user:' + userId);
    if (!user){
      try { conn.send(JSON.stringify({ type: 'auth_failed', reason: 'no_user' })); } catch(e){}
      try { conn.close(); } catch(e){}
      return false;
    }
    const player = this.players.get(conn.id);
    if (!player) return false;
    player.userId = userId;
    player.displayName = user.displayName;
    player.name = user.displayName;
    player.custom = (user.profile && user.profile.custom) || null;
    player.authed = true;

    // Send the world snapshot now that we know who this is
    conn.send(JSON.stringify({
      type: 'init',
      yourId: conn.id,
      userId, displayName: user.displayName,
      profile: user.profile || null,
      players: Array.from(this.players.values())
        .filter(p => p.authed && p.id !== conn.id)
        .map(p => ({
          id: p.id, name: p.name, custom: p.custom,
          x: p.x, y: p.y, z: p.z, ry: p.ry,
          moving: p.moving, inPit: p.inPit,
        })),
      coins: this.coins.filter(c => c.available).map(c => ({
        id: c.id, x: c.x, z: c.z, value: c.value,
      })),
      powerups: this.powerups.filter(p => p.available).map(p => ({
        id: p.id, x: p.x, z: p.z, type: p.type,
      })),
      chests: this.chests.filter(c => c.available).map(c => ({
        id: c.id, x: c.x, z: c.z, value: c.value, slots: c.slots,
      })),
      bigTreasure: this.bigTreasure.available ? {
        x: this.bigTreasure.x, z: this.bigTreasure.z, value: this.bigTreasure.value,
      } : null,
      plots: this.plots.map(p => ({
        id: p.id, ownerId: p.ownerId, ownerName: p.ownerName, build: p.build,
      })),
      scoreboard: this.scoreboard.slice(0, 10),
      chatHistory: (this.chatHistory || []).slice(-30),
      waves: this.waves,
      storm: this.storm,
    }));

    this.broadcast({
      type: 'join',
      player: {
        id: conn.id, name: player.name, custom: player.custom,
        x: player.x, y: player.y, z: player.z, ry: player.ry,
        moving: false, inPit: false,
      },
    }, [conn.id]);
    return true;
  }

  async onMessage(raw, sender){
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const player = this.players.get(sender.id);
    if (!player) return;

    // Pre-auth: only the `auth` message is honoured
    if (!player.authed){
      if (msg.type === 'auth') await this.handleAuth(sender, msg);
      return;
    }

    if (msg.type === 'state'){
      player.x = +msg.x || 0;
      player.y = +msg.y || 0;
      player.z = +msg.z || 0;
      player.ry = +msg.ry || 0;
      player.moving = !!msg.moving;
      player.inPit  = !!msg.inPit;
      this.broadcast({
        type: 'state',
        id: sender.id,
        x: player.x, y: player.y, z: player.z, ry: player.ry,
        moving: player.moving, inPit: player.inPit,
      }, [sender.id]);
    } else if (msg.type === 'identify'){
      // Display name is locked to the account. Cosmetics can update.
      player.custom = msg.custom || null;
      this.broadcast({
        type: 'identify',
        id: sender.id,
        name: player.name,
        custom: player.custom,
      }, [sender.id]);
      // Persist cosmetics into the user's profile so they survive reconnects
      try {
        const user = await this.room.storage.get('user:' + player.userId);
        if (user){
          user.profile = user.profile || {};
          user.profile.custom = player.custom;
          await this.room.storage.put('user:' + player.userId, user);
        }
      } catch(e){}
    } else if (msg.type === 'profile_save'){
      // Full progress snapshot from the client. Throttling is on the client.
      try {
        const user = await this.room.storage.get('user:' + player.userId);
        if (!user) return;
        user.profile = {
          custom: msg.custom || (user.profile && user.profile.custom) || null,
          progress: msg.progress || null,
        };
        await this.room.storage.put('user:' + player.userId, user);
      } catch(e){}
    } else if (msg.type === 'pickup_attempt'){
      const coin = this.coins.find(c => c.id === msg.coinId);
      if (coin && coin.available){
        coin.available = false;
        // Spillover coins don't respawn — they're one-shot drops from chests
        if (!coin.spillover) coin.respawnAt = Date.now() + COIN_RESPAWN_MS;
        this.broadcast({
          type: 'coin_pickup',
          id: coin.id,
          byId: sender.id,
          byName: player.name,
          value: coin.value,
        });
        if (coin.spillover){
          this.coins = this.coins.filter(c => c.id !== coin.id);
        }
      }
    } else if (msg.type === 'powerup_attempt'){
      const p = this.powerups.find(x => x.id === msg.powerupId);
      if (p && p.available){
        p.available = false;
        p.respawnAt = Date.now() + POWERUP_RESPAWN_MS;
        this.broadcast({
          type: 'powerup_pickup',
          id: p.id,
          buffType: p.type,
          byId: sender.id,
          byName: player.name,
        });
      }
    } else if (msg.type === 'chest_drop'){
      const value = +msg.value || 0;
      const slots = +msg.slots || 0;
      if (value <= 0 || slots <= 0) return;
      const chest = {
        id: 'chest_' + (this.nextChestId++),
        x: +msg.x || 0,
        z: +msg.z || 0,
        value, slots,
        ownerName: player.name,
        available: true,
      };
      this.chests.push(chest);
      this.broadcast({
        type: 'chest_spawn',
        id: chest.id, x: chest.x, z: chest.z,
        value, slots, ownerName: chest.ownerName,
      });
    } else if (msg.type === 'plot_buy'){
      const plot = this.plots.find(p => p.id === msg.plotId);
      if (!plot || plot.ownerId) return;
      plot.ownerId = player.userId;
      plot.ownerName = player.name;
      plot.build = { floor:'', walls:'', roof:'', furniture:'', decoration:'' };
      this.plotsDirty = true;
      this.broadcast({
        type: 'plot_owned',
        plotId: plot.id,
        ownerId: player.userId,
        ownerName: player.name,
      });
    } else if (msg.type === 'plot_build'){
      const plot = this.plots.find(p => p.id === msg.plotId);
      if (!plot || plot.ownerId !== player.userId) return;
      const slot = msg.slot;
      if (!['floor','walls','roof','furniture','decoration'].includes(slot)) return;
      plot.build[slot] = String(msg.itemId || '').slice(0, 32);
      this.plotsDirty = true;
      this.broadcast({
        type: 'plot_built',
        plotId: plot.id,
        slot,
        itemId: plot.build[slot],
        byId: sender.id,
      });
    } else if (msg.type === 'big_treasure_attempt'){
      if (this.bigTreasure.available){
        this.bigTreasure.available = false;
        this.bigTreasure.respawnAt = Date.now() + BIG_TREASURE_RESPAWN_MS;
        this.broadcast({
          type: 'big_treasure_picked',
          byId: sender.id,
          byName: player.name,
          value: this.bigTreasure.value,
        });
      }
    } else if (msg.type === 'chest_pickup_attempt'){
      const c = this.chests.find(x => x.id === msg.chestId);
      if (!c || !c.available) return;
      c.available = false;
      const carryMax   = +msg.carryMax || 10;
      const currentBag = +msg.currentBag || 0;
      const space = Math.max(0, carryMax - currentBag);
      const takenSlots  = Math.min(c.slots, space);
      const takenValue  = c.slots > 0 ? Math.floor(c.value * takenSlots / c.slots) : 0;
      const leftSlots   = c.slots - takenSlots;
      const leftValue   = c.value - takenValue;
      this.broadcast({
        type: 'chest_picked',
        id: c.id,
        byId: sender.id, byName: player.name,
        takenSlots, takenValue,
        x: c.x, z: c.z,
      });
      // Excess scatters as ground coins (spillover, no respawn)
      if (leftSlots > 0 && leftValue > 0){
        const perCoin = Math.max(1, Math.floor(leftValue / leftSlots));
        let remaining = leftValue;
        for (let i = 0; i < leftSlots; i++){
          const value = (i === leftSlots - 1) ? remaining : perCoin;
          remaining -= perCoin;
          const coin = {
            id: 'spill_' + sender.id.slice(0,4) + '_' + (this.nextChestId++),
            x: c.x + (Math.random() - 0.5) * 4,
            z: c.z + (Math.random() - 0.5) * 4,
            value,
            available: true,
            respawnAt: 0,
            spillover: true,
          };
          this.coins.push(coin);
          this.broadcast({
            type: 'coin_spawn',
            coin: { id: coin.id, x: coin.x, z: coin.z, value: coin.value },
          });
        }
      }
      this.chests = this.chests.filter(x => x.id !== c.id);
    } else if (msg.type === 'punch_attempt'){
      const target = this.players.get(String(msg.targetId || ''));
      if (!target || target === player) return;
      const now = Date.now();
      if (now - (this.lastPunch?.get(sender.id) || 0) < 2000) return;   // 2s cooldown
      const dx = target.x - player.x;
      const dz = target.z - player.z;
      const distSq = dx*dx + dz*dz;
      if (distSq > 36) return;   // out of range (6 units, bat reach)
      if (!this.lastPunch) this.lastPunch = new Map();
      this.lastPunch.set(sender.id, now);
      const dist = Math.sqrt(distSq) || 1;
      // Strength scales knockback: base 80 + 20 per level
      // With client decay ~0.05/sec (k≈3), distance ≈ magnitude / 3 units
      // Lv 0 ≈ 27m, Lv 5 ≈ 60m, Lv 10 ≈ 93m
      const strengthLv = Math.max(0, Math.min(20, +msg.strength || 0));
      const magnitude = 80 + strengthLv * 20;
      this.broadcast({
        type: 'punch_hit',
        attackerId: sender.id, attackerName: player.name,
        targetId: target.id, targetName: target.name,
        dirX: dx / dist, dirZ: dz / dist,
        magnitude,
        stun: Math.random() < 0.5,   // 50% chance to stun
      });
    } else if (msg.type === 'score'){
      this.recordScore(player.userId, player.displayName, +msg.maxDist || 0);
    } else if (msg.type === 'chat'){
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      const chatMsg = {
        type: 'chat',
        id: sender.id,
        name: player.name,
        text,
        ts: Date.now(),
      };
      if (!this.chatHistory) this.chatHistory = [];
      this.chatHistory.push(chatMsg);
      if (this.chatHistory.length > 50) this.chatHistory.splice(0, this.chatHistory.length - 50);
      this.broadcast(chatMsg);
    }
  }

  onClose(conn){
    const p = this.players.get(conn.id);
    this.players.delete(conn.id);
    if (p && p.authed){
      this.broadcast({ type: 'leave', id: conn.id });
    }
  }

  onError(conn, err){
    console.error('WorldServer error', err);
  }
}
