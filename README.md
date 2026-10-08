# Cursed Lands (prototype v0.5)

A Minecraft-style voxel multiplayer game that runs in Chrome. No Unity, no downloads, no npm packages.
Right now it is a plain Minecraft-like world. The plan is to reskin it with tech/machine models later and add the Titans and the curse on top.

## Run it on your PC
1. Install Node.js 18 or newer (https://nodejs.org).
2. In this folder run: `node server.js`
3. Open http://localhost:3000, create an account, click to play.
4. To test multiplayer, open a second tab in a private window and create another account.

## Controls
- WASD move, Space jump / swim up, Shift sprint, mouse look, V fly (Space up, C down)
- **F grapple gun**: fires at what you are looking at (55 blocks) and reels you in. Tap F again or press Space to let go (Space launches you). Great for climbing cliffs and arena towers
- **C slide**: sprint-slide in your move direction, press Space mid-slide to slide-jump. You also shrink to fit through 1-block gaps
- **T** cycles first person / third person behind / third person in front
- 1 sword, 2 bow, 3-9 blocks (mouse wheel cycles)
- Left click: swing the sword at mobs, or mine the block you look at. Right click: place a block
- Bow: hold left click to draw, release to shoot. Aim at the head for a headshot (2.5x damage)
- Q block palette (pick which block sits in the selected hotbar slot), E crafting, R switch arrow type
- G eat raw meat (heals 3 hearts), Enter chat

## The world
- Biomes: plains, forest, desert (cacti), snowy tundra (spruce trees). Lakes and seas with sand and gravel shores.
- Blocks: grass, dirt, stone, cobblestone, sand, gravel, oak log, planks, leaves, spruce leaves, snow, cactus, bedrock, coal / iron / diamond ore.
- Textured blocks (16x16 pixel art painted in code, no copyrighted assets), ambient occlusion, clouds, sun, moon and stars.
- A day lasts 10 minutes. Night is dark and zombies and spiders come out. They burn off at dawn.

## Mobs
| Mob | Behaviour | Drops |
|---|---|---|
| Pig, Cow, Sheep | graze in herds, panic together when one is hurt | Raw Meat |
| Chicken | same, flaps when it flees | Feather, Raw Meat |
| Wolf | peaceful until you hurt one, then the whole pack attacks | Bone |
| Zombie | hunts you on sight (mostly at night) | Iron (rare), Bone |
| Spider | fast, hunts you at night | String, Bone |

## Progression
Break tree trunks for logs, mine coal / iron / diamond underground, hunt for feathers, string and bone. Press E to craft:

- Arrows x5, Iron Arrows (hit harder), Frost Arrows (freeze a mob for 3s), Flame Arrows (huge damage)
- Iron Sword (damage 8), Diamond Sword (damage 14), Power Bow (+35% damage, faster draw)

You start with a Wooden Sword, a Bow and 10 Arrows. If something kills you, you respawn at the start.
Block placing is unlimited (creative style) for now.

## Host it free (Render.com)
1. Put this folder in a GitHub repo.
2. On render.com: New > Web Service > connect the repo.
3. Runtime: Node. Build command: leave empty. Start command: `node server.js`.
4. Plan: Free. Deploy, then share the URL. WebSockets work by default.

Free-tier limits to expect:
- The service sleeps after ~15 minutes with no visitors; the first visit takes ~30-60 seconds to wake.
- The disk is wiped on every redeploy/restart, so accounts, inventories and built blocks reset.
  Fine for testing. When you move to a better host, set `DATA_DIR` to a persistent disk path,
  or we move accounts and world data to a database.

Cloudflare Pages / Netlify / Vercel will NOT work, they cannot hold WebSocket connections.

## Settings (environment variables)
`PORT` (default 3000), `WORLD_SEED` (default 1337), `DATA_DIR` (default ./data),
`START_PHASE` (time of day the world starts at: 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight; default 0.08)

## Files
- `server.js` HTTP + login + WebSocket multiplayer, combat, crafting, day/night clock (zero dependencies)
- `mobs.js` mob herd simulation and spawning
- `public/terrain.mjs` terrain, biomes, trees and ores, shared by server and browser (so both agree on the ground)
- `public/index.html`, `public/game.js` the browser game (chunk meshing, player, hand, UI, sky)
- `public/textures.js` block atlas, block table, item sprites and the extruded 3D held items
- `public/creatures.js` mob and player models (box models with painted skins) and their animation
- `public/viewer.html` mob viewer, `public/atlas.html` texture viewer: open them while the server runs
- `public/vendor/` Three.js r186, bundled so nothing loads from a CDN

## Known prototype limits
- Mobs walk on the original terrain height, so they ignore blocks players build.
- Arrows are judged by the server against mobs and the natural ground, so an arrow can pass through a wall you built and still hit a mob behind it.
- No caves yet, no block-breaking time, no sound.

## Next steps
1. Swap the Minecraft models and textures for the machine / tech look
2. Cursed zones: a Titan per zone, the 5-minute curse timer, cure + camps
3. Taming/overriding mobs (Horizon style), mounts
4. The ending loop: the Curse passes to the winner, who becomes a Titan in the next world

## PvP and the Arena
- Swords and arrows hurt other players anywhere in the world (damage is scaled for 20 HP). Melee knocks the victim back. Dying in the open sends you to spawn.
- **The Arena** is a walled pit with a ziggurat, pillars, cover and four climbable corner towers, placed from the world seed (the top-left info panel shows its distance and direction, or type `/arena` in chat to teleport there, `/spawn` to come back). It is not buildable.
- Stepping inside makes it a **free for all**: hotbar slots 3-6 become guns with ammo (refilled on every respawn, plus a top-up and +3 hearts per kill). A scoreboard of kills / deaths shows at the top.

| Gun | Damage | Fire rate | Notes |
|---|---|---|---|
| Pistol | 7 | 3.3/s | accurate |
| Rifle | 3 | 9/s, hold to fire | spreads when sprayed |
| Shotgun | 8 pellets x 3.5 | 1.2/s | deadly up close |
| Sniper | 15 | 0.7/s | right click zooms, headshot = 30 |

Headshots do double damage (the shotgun 1.5x). Guns are server-side hitscan and only work inside the arena. `/arena` and `/spawn` are the only chat commands.
