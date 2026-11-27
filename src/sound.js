// 효과음과 캐릭터 목소리
import { charById } from './fb.js';

let settings = { on: true, volume: 0.8 };
const cache = new Map();

export function setSound(s) { settings = { on: s?.on !== false, volume: s?.volume ?? 0.8 }; }

export function play(name, vol = 1) {
  if (!settings.on) return;
  const src = name.includes('/') ? `assets/${name}` : `assets/sounds/${name}.wav`;
  let base = cache.get(src);
  if (!base) { base = new Audio(src); base.preload = 'auto'; cache.set(src, base); }
  const a = base.cloneNode();
  a.volume = Math.max(0, Math.min(1, settings.volume * vol));
  a.play().catch(() => {});
}

export function voice(charId, kind, vol = 0.9) {
  const c = charById(charId);
  const p = c?.voices?.[kind];
  if (p) play(p, vol);
}
