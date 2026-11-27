// 캐릭터 폴더의 파일 이름을 보고 manifest.json 초안을 만들어요. (한 번만 쓰는 도구)
// 이후에는 assets/manifest.json을 직접 고치면 돼요.
import fs from 'node:fs';
const dir = 'assets/characters';
const NAMES = { monkey: '원숭이', ferret: '흰 족제비', otter: '해달', fennec: '사막여우' };
// 앱 동작 이름 → 캐릭터별 파일 접두어(앞에 있는 것부터 찾아요)
const MAP = {
  idle: ['idle'], walk: ['walk'], sit: ['sit'], rest: ['rest', 'sleep'], held: ['held', 'lift'],
  hitCan: ['hit_can', 'can_hit'], hitBolt: ['hit_bolt', 'lightning_hit'], throw: ['throw'],
  send: ['send', 'note_throw'], read: ['read', 'note_receive'], poop: ['poop'], full: ['full'], sigh: ['sigh'],
};
const FPS = { idle: 2.2, walk: 8, sit: 1.5, rest: 1, held: 3, hitCan: 5, hitBolt: 5, throw: 8, send: 6, read: 3, poop: 2.5, full: 2, sigh: 1.6 };
const LOOP = { idle: true, walk: true, sit: true, rest: true, held: true };
const chars = [];
for (const id of ['monkey', 'ferret', 'otter', 'fennec']) {
  const files = fs.readdirSync(`${dir}/${id}`).filter((f) => f.endsWith('.png')).sort();
  const pick = (p) => files.filter((f) => new RegExp(`^${id}_${p}_\\d+\\.png$`).test(f)).map((f) => `characters/${id}/${f}`);
  const anims = {};
  for (const [act, prefixes] of Object.entries(MAP)) {
    let frames = [];
    for (const p of prefixes) { frames = pick(p); if (frames.length) break; }
    if (!frames.length) throw new Error(`${id}: ${act} 프레임이 없어요`);
    anims[act] = { frames, fps: FPS[act], loop: !!LOOP[act] };
  }
  const card = pick('select')[0] || pick('card')[0];
  chars.push({
    id, label: NAMES[id], facing: 'right', face: pick('face')[0], card, anims,
    voices: Object.fromEntries(['default', 'happy', 'hit', 'pickup'].map((k) => [k, `sounds/${id}_voice_${k}.wav`])),
  });
}
const manifest = { frameSize: 512, footY: 450, displaySize: 128, characters: chars };
fs.writeFileSync('assets/manifest.json', JSON.stringify(manifest, null, 2));
console.log('ok', chars.map((c) => `${c.id}:${Object.values(c.anims).reduce((n, a) => n + a.frames.length, 0)}`).join(' '));
