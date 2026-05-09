// Escape Tsunami For Money — multiplayer relay server.
//
// Phase 1A: pure position relay. Each player's tsunamis & coins are still
// local; we just broadcast everyone's position / facing / animation flags so
// you can see your friends running around the same world.
//
// Phase 1B (next iteration) will move tsunami spawning here so everyone
// shares the same waves.

export default class WorldServer {
  constructor(room) {
    this.room = room;
    this.players = new Map();   // connection.id -> player record
  }

  onConnect(conn) {
    const player = {
      id: conn.id,
      name: '???',
      custom: null,
      x: 0, y: 0, z: 8, ry: 0,
      moving: false, inPit: false,
    };
    this.players.set(conn.id, player);

    // Tell the new player who else is here (and their own id)
    conn.send(JSON.stringify({
      type: 'init',
      yourId: conn.id,
      players: Array.from(this.players.values()),
    }));

    // Tell everyone else someone joined
    this.room.broadcast(JSON.stringify({
      type: 'join',
      player,
    }), [conn.id]);
  }

  onMessage(raw, sender) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const player = this.players.get(sender.id);
    if (!player) return;

    if (msg.type === 'state') {
      player.x = +msg.x || 0;
      player.y = +msg.y || 0;
      player.z = +msg.z || 0;
      player.ry = +msg.ry || 0;
      player.moving = !!msg.moving;
      player.inPit = !!msg.inPit;
      this.room.broadcast(JSON.stringify({
        type: 'state',
        id: sender.id,
        x: player.x, y: player.y, z: player.z, ry: player.ry,
        moving: player.moving, inPit: player.inPit,
      }), [sender.id]);
    } else if (msg.type === 'identify') {
      player.name = String(msg.name || '???').slice(0, 16);
      player.custom = msg.custom || null;
      this.room.broadcast(JSON.stringify({
        type: 'identify',
        id: sender.id,
        name: player.name,
        custom: player.custom,
      }), [sender.id]);
    } else if (msg.type === 'chat') {
      const text = String(msg.text || '').slice(0, 120);
      if (!text) return;
      this.room.broadcast(JSON.stringify({
        type: 'chat',
        id: sender.id,
        name: player.name,
        text,
      }));
    }
  }

  onClose(conn) {
    this.players.delete(conn.id);
    this.room.broadcast(JSON.stringify({
      type: 'leave',
      id: conn.id,
    }));
  }

  onError(conn, err) {
    console.error('WorldServer error', err);
  }
}
