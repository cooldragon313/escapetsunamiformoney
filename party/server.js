// Escape Tsunami For Money — multiplayer authoritative world server.
//
// Phase 1B: server owns coins, tsunamis, and the storm cycle. Clients render
// what the server tells them; coin pickups race through the server so first
// player to claim wins.

const RUNWAY_LEN     = 2000;
const RUNWAY_HALF_W  = 20;
const ZONE_LEN       = 200;
const NUM_ZONES      = 10;
const HILL_START_Z   = 4;
const COIN_RESPAWN_MS = 60_000;
const POWERUP_RESPAWN_MS = 45_000;
const BIG_TREASURE_RESPAWN_MS = 600_000;   // 10 minutes
const BIG_TREASURE_VALUE = 50;
const BIG_TREASURE_Z = -1000;             // boundary of old map / start of new content

// Heights kept in sync with the client; server only uses speedMul / width
// for spawn calculations.
const WAVE_TYPES = [
  { id:'green',  height:8,  width:14, speedMul:1.0,  weight:18, storm:false },
  { id:'blue',   height:15, width:18, speedMul:1.0,  weight:30, storm:false },
  { id:'red',    height:15, width:14, speedMul:1.8,  weight:18, storm:false },
  { id:'wide',   height:15, width:32, speedMul:0.85, weight:14, storm:false },
  { id:'purple', height:25, width:RUNWAY_HALF_W*2 + 12, speedMul:0.7, weight:8, storm:true },
  { id:'titan',  height:50, width:RUNWAY_HALF_W*2 + 12, speedMul:0.5, weight:3, storm:true },
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
    // Plots: 9-tile grid behind the base. ownerId is the connection id of the
    // current owner (or null if for sale).
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
    this.lastTick = Date.now();
    this.tickHandle = setInterval(() => this.tick(), 50);
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
      const count  = 14 + zone * 10;
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

    // Wave spawning (only if at least one player is in danger zone)
    if (this.players.size > 0){
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
        this.nextSpawnIn *= 0.9;   // +10% spawn rate vs previous tuning

        // Use the deepest player to set difficulty
        let minZ = 8;
        for (const p of this.players.values()) if (p.z < minZ) minZ = p.z;

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
    const player = {
      id: conn.id, name: '???', custom: null,
      x: 0, y: 0, z: 8, ry: 0, moving: false, inPit: false,
    };
    this.players.set(conn.id, player);

    // Send full world snapshot
    conn.send(JSON.stringify({
      type: 'init',
      yourId: conn.id,
      players: Array.from(this.players.values()),
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
      waves: this.waves,
      storm: this.storm,
    }));

    this.broadcast({ type: 'join', player }, [conn.id]);
  }

  onMessage(raw, sender){
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const player = this.players.get(sender.id);
    if (!player) return;

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
      player.name = String(msg.name || '???').slice(0, 16);
      player.custom = msg.custom || null;
      this.broadcast({
        type: 'identify',
        id: sender.id,
        name: player.name,
        custom: player.custom,
      }, [sender.id]);
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
          // Remove entirely so it never comes back
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
      plot.ownerId = sender.id;
      plot.ownerName = player.name;
      plot.build = { floor:'', walls:'', roof:'', furniture:'', decoration:'' };
      this.broadcast({
        type: 'plot_owned',
        plotId: plot.id,
        ownerId: sender.id,
        ownerName: player.name,
      });
    } else if (msg.type === 'plot_build'){
      const plot = this.plots.find(p => p.id === msg.plotId);
      if (!plot || plot.ownerId !== sender.id) return;
      const slot = msg.slot;
      if (!['floor','walls','roof','furniture','decoration'].includes(slot)) return;
      plot.build[slot] = String(msg.itemId || '').slice(0, 32);
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
    } else if (msg.type === 'chat'){
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      this.broadcast({
        type: 'chat',
        id: sender.id,
        name: player.name,
        text,
      });
    }
  }

  onClose(conn){
    this.players.delete(conn.id);
    this.broadcast({ type: 'leave', id: conn.id });
  }

  onError(conn, err){
    console.error('WorldServer error', err);
  }
}
