// 우가우가 — 바탕화면 오버레이
// 캐릭터 돌아다니기, 기분 말풍선, 던지기, 종이비행기 쪽지, 포춘쿠키, 똥싸기·배부름·인생무상
import {
  ref, get, set, update, remove, push, onValue, onChildAdded, onChildRemoved, onDisconnect,
  serverTimestamp, runTransaction,
} from 'firebase/database';
import {
  initFirebase, currentUser, db, R, manifest, charById, el, dayKey, LIMITS, friendlyError,
} from './fb.js';
import { play, voice, setSound } from './sound.js';
import FORTUNES from './gen/fortunes.json';

const stage = document.getElementById('stage');
const toasts = document.getElementById('toasts');
const D = manifest.displaySize;            // 화면에 그리는 크기(px)
const FOOT = manifest.footY / manifest.frameSize * D; // 그림 윗변 → 발바닥 거리
const GRAVITY = 2200, WALK_SPEED = 46, WALK_MAX = 420;
document.documentElement.style.setProperty('--d', D + 'px');

let config = {}, room = '', myUid = '', W = 1280, GROUND = 700;
let members = {}, status = {}, online = {}, away = {}, myAway = false;
let pets = new Map();                       // uid → Pet
let serverOffset = 0, connected = false, yielded = false, leaving = false;
let myConn = null;
let stoppers = [];                          // 양보할 때 멈출 구독들
const notes = new Map();                    // noteId → { data, el }
const dndQueue = [];
let lastThrow = 0, lastAct = 0, lastNote = 0;

// ---------------------------------------------------------------- 캐릭터
class Pet {
  constructor(uid, charId) {
    this.uid = uid; this.setChar(charId);
    this.x = 120 + Math.random() * Math.max(100, W - 240);
    this.y = 0; this.vy = 0; this.dir = Math.random() < 0.5 ? 1 : -1;
    this.anim = 'idle'; this.frame = 0; this.ft = 0; this.until = 0; this.onEnd = null;
    this.targetX = null; this.held = false; this.falling = false;
    this.el = el('div', { class: 'pet hit' }, this.img = el('img', { class: 'spr', draggable: 'false' }));
    this.tag = el('div', { class: `tag${uid === myUid ? ' me' : ''}` });
    stage.append(this.el, this.tag);
    this.el.addEventListener('mousedown', (e) => onPetDown(e, this));
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (this.uid === myUid) window.api.openSettings(); });
    this.decide(performance.now());
  }
  setChar(charId) { this.charId = charId; this.c = charById(charId); this.facing = this.c.facing === 'left' ? -1 : 1; }
  get isMe() { return this.uid === myUid; }
  get busy() { return this.until > performance.now() || this.held || this.falling; }
  frames(name) {
    if (name === 'hitPoop') { // 똥 맞으면 찡그린 얼굴(맞음2)을 계속 보여 줘요
      const h = this.c.anims.hitCan; return { frames: [h.frames[Math.min(1, h.frames.length - 1)]], fps: 5, loop: false };
    }
    // 장난 반응: 있는 그림에서 한 장씩 골라 써요
    const pick = { startle: ['held', 1], squirm: ['held', 0], slipped: ['hitBolt', 2] }[name];
    if (pick) { const h = this.c.anims[pick[0]]; return { frames: [h.frames[Math.min(pick[1], h.frames.length - 1)]], fps: 5, loop: false }; }
    return this.c.anims[name] || this.c.anims.idle;
  }
  set(name) { if (this.anim !== name) { this.anim = name; this.frame = 0; this.ft = 0; } }
  // 한 번 재생하는 동작 (ms 동안 다른 동작을 하지 않아요)
  playOnce(name, ms, onEnd) {
    this.targetX = null; this.anim = name; this.frame = 0; this.ft = 0;
    const a = this.frames(name);
    this.until = performance.now() + (ms || (a.frames.length / a.fps) * 1000 + 400);
    this.onEnd = onEnd || null;
  }
  decide(now) {
    const opts = [['walk', 30], ['idle', 16], ['sit', 14], ['rest', 8]].filter(([n]) => n !== this.lastChoice);
    let r = Math.random() * opts.reduce((s, o) => s + o[1], 0), pick = 'idle';
    for (const [n, w] of opts) { if ((r -= w) <= 0) { pick = n; break; } }
    this.lastChoice = pick;
    if (pick === 'walk') {
      const dx = (Math.random() * 2 - 1) * WALK_MAX;
      this.targetX = Math.max(D / 2, Math.min(W - D / 2, this.x + dx));
      this.set('walk');
      this.nextDecide = Infinity;
    } else {
      this.targetX = null; this.set(pick);
      const dur = { idle: [3, 7], sit: [5, 10], rest: [6, 12] }[pick];
      this.nextDecide = now + (dur[0] + Math.random() * (dur[1] - dur[0])) * 1000;
    }
  }
  update(dt, now) {
    if (this.held) { this.set('held'); }
    else if (this.falling) {
      this.vy -= GRAVITY * dt; this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; this.falling = false; play('drop', 0.7); this.playOnce('idle', 600); }
    } else if (this.until) {
      if (now >= this.until) { this.until = 0; const f = this.onEnd; this.onEnd = null; this.set('idle'); this.nextDecide = now + 1500; if (f) f(); }
    } else if (this.away) {
      this.targetX = null; this.set('rest'); this.nextDecide = now + 1500;
    } else if (this.targetX != null) {
      const d = this.targetX - this.x;
      this.dir = d >= 0 ? 1 : -1;
      const step = WALK_SPEED * dt;
      if (Math.abs(d) <= step) { this.x = this.targetX; this.targetX = null; this.decide(now); }
      else this.x += step * this.dir;
    } else if (now >= this.nextDecide) this.decide(now);

    const a = this.frames(this.anim);
    this.ft += dt;
    const spf = 1 / (a.fps || 2);
    while (this.ft >= spf) {
      this.ft -= spf;
      if (a.loop || this.frame < a.frames.length - 1) this.frame = (this.frame + 1) % a.frames.length;
    }
  }
  render(hiddenAll) {
    const hide = hiddenAll || this.hidden;
    this.el.classList.toggle('gone', hide);
    this.tag.style.display = hide ? 'none' : '';
    if (this.bubble) this.bubble.style.display = hide ? 'none' : '';
    if (hide) return;
    const a = this.frames(this.anim);
    const src = `assets/${a.frames[Math.min(this.frame, a.frames.length - 1)]}`;
    if (this.img.dataset.src !== src) { this.img.src = src; this.img.dataset.src = src; }
    const left = this.x - D / 2, top = GROUND - this.y - FOOT;
    this.el.style.transform = `translate(${left}px, ${top}px)`;
    this.img.style.transform = this.dir * this.facing < 0 ? 'scaleX(-1)' : '';
    this.tag.style.left = this.x + 'px';
    this.tag.style.top = (this.headTop() - 2) + 'px';
    if (this.bubble) { this.bubble.style.left = this.x + 'px'; this.bubble.style.top = this.headTop() - 30 + 'px'; }
  }
  headTop() { return GROUND - this.y - FOOT + D * 0.26; }       // 머리 위 (말풍선 자리)
  headCenter() { return { x: this.x, y: GROUND - this.y - FOOT + D * 0.48 }; }
  handPos() { return { x: this.x + this.dir * this.facing * D * 0.25, y: GROUND - this.y - FOOT + D * 0.55 }; }
  setTag(name, badges) { this.tag.textContent = `${badges ? badges + ' ' : ''}${name}`; }
  setBubble(text, kind = 'mood') {
    if (kind === 'mood') this.moodText = text || '';
    const show = this.sayText || this.moodText;
    if (!show) { if (this.bubble) { this.bubble.remove(); this.bubble = null; } return; }
    if (!this.bubble) { this.bubble = el('div', { class: 'bubble' }); stage.append(this.bubble); }
    this.bubble.textContent = show;
    this.bubble.classList.toggle('say', !!this.sayText);
  }
  say(text, ms = 2600) {
    this.sayText = text; this.setBubble(this.moodText);
    clearTimeout(this.sayT); this.sayT = setTimeout(() => { this.sayText = ''; this.setBubble(this.moodText); }, ms);
  }
  destroy() { this.el.remove(); this.tag.remove(); if (this.bubble) this.bubble.remove(); }
}

// ---------------------------------------------------------------- 마우스: 클릭 통과 처리
let ignoring = true, dragging = null;
function setIgnore(v) { if (v !== ignoring) { ignoring = v; window.api.setIgnore(v); } }
window.addEventListener('mousemove', (e) => {
  if (dragging) return dragMove(e);
  const t = document.elementFromPoint(e.clientX, e.clientY);
  setIgnore(!(t && t.closest('.hit')));
});
window.addEventListener('mouseup', (e) => { if (dragging) dragEnd(e); });
window.addEventListener('blur', () => closeMenus());
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenus(); closeCards(); } });
// 입력칸을 누르면 창에 키보드 초점을 줘요
document.addEventListener('mousedown', (e) => { if (e.target.closest('input,textarea')) window.api.focusPet(); }, true);

function onPetDown(e, pet) {
  if (e.button !== 0) return;
  e.preventDefault();
  dragging = { pet, sx: e.clientX, sy: e.clientY, moved: false, ox: e.clientX - pet.x, oy: (GROUND - pet.y) - e.clientY };
}
function dragMove(e) {
  const d = dragging;
  if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) {
    d.moved = true; d.pet.held = true; d.pet.targetX = null; d.pet.until = 0; d.pet.el.classList.add('held');
    voice(d.pet.charId, 'pickup', 0.7);
    closeMenus();
  }
  if (d.moved) {
    d.pet.x = Math.max(D / 2, Math.min(W - D / 2, e.clientX - d.ox));
    d.pet.y = Math.max(0, GROUND - (e.clientY + d.oy));
  }
}
function dragEnd() {
  const d = dragging; dragging = null;
  d.pet.el.classList.remove('held');
  if (d.moved) { d.pet.held = false; d.pet.falling = d.pet.y > 0; d.pet.vy = 0; if (!d.pet.falling) d.pet.playOnce('idle', 500); return; }
  // 클릭
  if (d.pet.isMe) openMyMenu(d.pet); else openFriendMenu(d.pet);
}

// ---------------------------------------------------------------- 메뉴
let openPops = [];
function closeMenus() { openPops.filter((p) => p.dataset.kind === 'menu').forEach((p) => p.remove()); openPops = openPops.filter((p) => p.isConnected); }
function closeCards() { openPops.forEach((p) => p.remove()); openPops = []; }
function placePop(pop, x, yBottom) {
  stage.append(pop);
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(W - w - 8, x - w / 2)) + 'px';
  pop.style.top = Math.max(8, yBottom - h) + 'px';
  openPops.push(pop);
  return pop;
}
function btn(emoji, label, onclick, opts = {}) {
  return el('button', { class: opts.on ? 'on' : '', disabled: opts.disabled, title: opts.title, onclick }, el('span', { class: 'e', text: emoji }), label);
}

function openMyMenu(pet) {
  closeMenus();
  play('window_open', 0.35);
  voice(pet.charId, 'default', 0.6);
  const m = members[myUid] || {};
  const pop = el('div', { class: 'pop hit', 'data-kind': 'menu' },
    el('div', { class: 'ph' }, el('img', { src: `assets/${pet.c.face}` }), el('div', {}, m.name || '나', el('div', { class: 'mood', text: config.dnd ? '🔕 방해금지 중' : '무엇을 할까요?' }))),
    el('div', { class: 'grid' },
      btn('💬', '기분', () => { closeMenus(); openMoodEditor(pet); }),
      btn('🥠', '포춘쿠키', () => { closeMenus(); openFortune(); }),
      btn('📢', '확성기', () => { closeMenus(); openMegaphone(); }),
      btn('💩', '똥싸기', () => { closeMenus(); doAct('poop'); }),
      btn('🍚', '배부름', () => { closeMenus(); doAct('full'); }),
      btn('🍃', '인생무상', () => { closeMenus(); doAct('sigh'); }),
      btn('🔕', '방해금지', () => { closeMenus(); window.api.setConfig({ dnd: !config.dnd }); }, { on: config.dnd }),
      btn('⚙️', '설정', () => { closeMenus(); window.api.openSettings(); }),
    ));
  placePop(pop, pet.x, pet.headTop() - 56);
}

function openFriendMenu(pet) {
  closeMenus();
  play('window_open', 0.35);
  voice(pet.charId, 'default', 0.6);
  const m = members[pet.uid] || {}, st = status[pet.uid] || {};
  const dnd = !!st.dnd;
  const mood = st.moodDay === dayKey() && st.mood ? `“${st.mood}”` : '';
  const pop = el('div', { class: 'pop hit', 'data-kind': 'menu' },
    el('div', { class: 'ph' }, el('img', { src: `assets/${pet.c.face}` }), el('div', {}, m.name || '친구', el('div', { class: 'mood', text: mood }))),
    el('div', { class: 'gl', text: '던지기' }),
    el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(4, 64px)' } },
      btn('🥫', '깡통', () => { closeMenus(); requestThrow(pet.uid, 'can'); }, { disabled: dnd }),
      btn('💩', '똥', () => { closeMenus(); requestThrow(pet.uid, 'poop'); }, { disabled: dnd }),
      btn('⚡', '번개', () => { closeMenus(); requestThrow(pet.uid, 'bolt'); }, { disabled: dnd }),
      btn('🎈', '물풍선', () => { closeMenus(); requestThrow(pet.uid, 'balloon'); }, { disabled: dnd }),
    ),
    el('div', { class: 'gl', text: '장난' }),
    el('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(5, 52px)' } },
      btn('🔨', '뿅망치', () => { closeMenus(); requestPrank(pet.uid, 'hammer'); }, { disabled: dnd }),
      btn('👉', '콕', () => { closeMenus(); requestPrank(pet.uid, 'poke'); }, { disabled: dnd }),
      btn('🪶', '간지럼', () => { closeMenus(); requestPrank(pet.uid, 'tickle'); }, { disabled: dnd }),
      btn('🍌', '바나나', () => { closeMenus(); requestBanana(pet.uid); }, { disabled: dnd }),
      btn('🏷️', '이름표', () => { closeMenus(); openNameTag(pet); }, { disabled: dnd }),
    ),
    el('div', { class: 'grid one' }, btn('✉️', '쪽지', () => { closeMenus(); openCompose(pet.uid); })),
    dnd ? el('div', { class: 'note', text: '🔕 방해금지 중이에요. 쪽지는 끝나면 도착해요.' }) : null);
  placePop(pop, pet.x, pet.headTop() - 56);
}

function openMoodEditor(pet) {
  const st = status[myUid] || {};
  const cur = st.moodDay === dayKey() ? st.mood || '' : '';
  const input = el('input', { maxlength: LIMITS.MOOD_MAX, value: cur, placeholder: '오늘의 기분 (30자)' });
  const save = async (text) => {
    pop.remove();
    await update(R(room, 'status', myUid), { mood: text, moodDay: dayKey(), updatedAt: serverTimestamp() }).catch((e) => toast(friendlyError(e)));
    play('window_close', 0.4);
  };
  const pop = el('div', { class: 'pop hit', style: { width: '260px' } },
    el('div', { class: 'ph', text: '💬 오늘의 기분' }), input,
    el('div', { class: 'ft' }, el('button', { onclick: () => save('') }, '지우기'), el('button', { onclick: () => pop.remove() }, '취소'),
      el('button', { class: 'primary', onclick: () => save(input.value.trim().slice(0, LIMITS.MOOD_MAX)) }, '저장')));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(input.value.trim().slice(0, LIMITS.MOOD_MAX)); });
  placePop(pop, pet.x, pet.headTop() - 20);
  window.api.focusPet(); setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------- 오류 기록 (사용자 폴더 log.txt)
function logError(where, e) {
  try { window.api.log(`[${where}] ${e?.code || ''} ${e?.message || e}`); } catch { /* */ }
}
window.addEventListener('error', (e) => logError('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => logError('promise', e.reason));

// ---------------------------------------------------------------- 알림
function toast(text, charId, ms = 4200) {
  const t = el('div', { class: 'toast' }, charId ? el('img', { src: `assets/${charById(charId).face}` }) : null, text);
  toasts.append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, ms);
}
const nameOf = (uid) => members[uid]?.name || '친구';

// ---------------------------------------------------------------- 신호(inbox)
function onlineOthers() { return Object.keys(online).filter((u) => u !== myUid && online[u]); }
async function sendEvent(targets, data) {
  const payload = { ...data, from: myUid, ts: serverTimestamp() };
  await Promise.all([...new Set(targets)].map((to) => push(R(room, 'inbox', to), payload))).catch((e) => console.warn(e));
}
function handleEvent(ev) {
  if (ev.type === 'throw') animateThrow(ev.from, ev.to, ev.item);
  else if (ev.type === 'act') animateAct(ev.from, ev.kind);
  else if (ev.type === 'notesent') animateNoteSend(ev.from, ev.to);
  else if (ev.type === 'prank') animatePrank(ev.from, ev.to, ev.kind);
  else if (ev.type === 'banana') placeBanana(ev.from, ev.to, ev.dx);
  else if (ev.type === 'nametag') setNameTag(ev.from, ev.to, ev.text);
  else if (ev.type === 'nametagoff') clearNameTag(ev.from, false);
}

// ---------------------------------------------------------------- 던지기
function requestThrow(toUid, item) {
  const now = Date.now();
  if (now - lastThrow < LIMITS.THROW_COOLDOWN) { toast('조금만 쉬었다 던져요 (3초)'); return; }
  if (status[toUid]?.dnd) { toast(`${nameOf(toUid)}님은 방해금지 중이에요 🔕`); return; }
  lastThrow = now;
  animateThrow(myUid, toUid, item);
  sendEvent(onlineOthers(), { type: 'throw', to: toUid, item });
}
function animateThrow(fromUid, toUid, item) {
  const from = pets.get(fromUid), to = pets.get(toUid);
  if (!to) return;
  if (toUid === myUid && config.dnd) return;                 // 받는 쪽에서도 방해금지면 무시
  if (from && !from.hidden) { from.dir = to.x >= from.x ? from.facing : -from.facing; from.playOnce('throw', 900); }
  play('can_throw', 0.8);
  setTimeout(() => {
    const a = from && !from.hidden ? from.handPos() : { x: to.x < W / 2 ? W + 40 : -40, y: GROUND - 300 };
    const img = el('img', { class: `fly${item === 'poop' || item === 'balloon' ? ' big' : ''}`, src: `assets/props/${{ bolt: 'bolt_fly', poop: 'poop_fly', balloon: 'water_balloon' }[item] || 'can_fly'}.png` });
    stage.append(img);
    const dur = item === 'bolt' ? 420 : 700, t0 = performance.now();
    const flipX = (to.x < a.x) ? -1 : 1;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      const b = hitPoint(to, item); // 맞는 그림이 뜨는 자리로 날아가요
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * (item === 'bolt' ? 40 : 140);
      const rot = item === 'bolt' ? 0 : (item === 'poop' || item === 'balloon') ? Math.sin(t * Math.PI * 4) * 10 : t * 720;
      img.style.transform = `translate(${x}px, ${y}px) scaleX(${flipX}) rotate(${rot}deg)`;
      if (t < 1) requestAnimationFrame(step);
      else { img.remove(); hit(to, item, fromUid); }
    };
    requestAnimationFrame(step);
  }, from && !from.hidden ? 280 : 0);
}
// 맞는 물건이 머리에 닿는 자리 (캐릭터별 머리 꼭대기 높이, 물건별 보정 px)
const HEAD_TOP = { monkey: 0.40, ferret: 0.37, otter: 0.46, fennec: 0.36 };
const ITEM_OFF = { can: -4, bolt: -6, poop: -19 };
function hitPoint(pet, item) {
  return { x: pet.x, y: GROUND - pet.y - FOOT + D * (HEAD_TOP[pet.charId] ?? 0.4) + (ITEM_OFF[item] ?? -4) };
}
function hit(pet, item, fromUid) {
  if (item === 'balloon') { balloonHit(pet, fromUid); return; }
  // 효과는 단순하게: 맞은 그림 한 번 + 소리 하나 + 짧은 맞는 동작
  const c = hitPoint(pet, item); // 머리에 닿게
  const fx = el('img', { class: 'impact', src: `assets/props/${{ bolt: 'bolt_hit', poop: 'poop_hit' }[item] || 'can_hit'}.png`, style: { left: c.x + 'px', top: c.y + 'px' } });
  stage.append(fx); setTimeout(() => fx.remove(), 1000);
  play({ bolt: 'bolt', poop: 'poop' }[item] || 'can_hit', 0.9);
  pet.held = false; pet.falling = false; pet.y = 0;
  pet.playOnce({ bolt: 'hitBolt', poop: 'hitPoop' }[item] || 'hitCan', 1500); // 물건(1초)이 사라질 때까지 맞는 동작 유지
  if (pet.uid === myUid && fromUid !== myUid) toast(`${nameOf(fromUid)}님이 ${{ bolt: '번개를 ⚡', poop: '똥을 💩', balloon: '물풍선을 🎈' }[item] || '빈 깡통을 🥫'} 던졌어요!`, members[fromUid]?.char);
}

// ---------------------------------------------------------------- 확성기 (방의 모든 친구에게)
// 화면 가운데에 압정 꽂힌 종이 한 장 + 아래 알약 모양 바. 창틀 없이 종이만 보여요.
function megaSheet(body, bar) {
  const sheet = el('div', { class: 'msheet hit' }, ...body);
  const wrap = el('div', { class: 'mwrap boom' },
    el('img', { class: 'mpin', src: 'assets/props/mega_pin.png', draggable: 'false' }),
    el('span', { class: 'mspk' }), sheet, el('div', { class: 'mbar hit' }, ...bar));
  stage.append(wrap); recenter(wrap); openPops.push(wrap);
  return { wrap, sheet };
}
function openMegaphone() {
  const others = Object.keys(members).filter((u) => u !== myUid);
  if (!others.length) { toast('아직 방에 친구가 없어요.'); return; }
  const ta = el('textarea', { class: 'mta', maxlength: LIMITS.NOTE_MAX, placeholder: '모두에게 외칠 말 (200자)' });
  const send = el('button', { class: 'primary' }, '📢 외치기');
  const cancel = el('button', {}, '취소');
  const { wrap } = megaSheet([ta], [el('span', { class: 'mlbl', text: '📢 모두에게 확성기' }), cancel, send]);
  cancel.onclick = () => { wrap.remove(); openPops = openPops.filter((p) => p !== wrap); };
  send.onclick = async () => {
    const text = ta.value.trim().slice(0, LIMITS.NOTE_MAX);
    if (!text) { ta.focus(); return; }
    send.disabled = true;
    if (await sendMega(text, null)) cancel.onclick(); else send.disabled = false;
  };
  window.api.focusPet(); setTimeout(() => ta.focus(), 60);
}
// 확성기 보내기: 나를 뺀 방의 모든 친구에게 (꺼져 있으면 켤 때 받아요)
async function sendMega(text, re) {
  if (Date.now() - lastNote < LIMITS.NOTE_COOLDOWN) { toast('천천히 보내 주세요'); return false; }
  lastNote = Date.now();
  const others = Object.keys(members).filter((u) => u !== myUid);
  const me = members[myUid] || {};
  const payload = { from: myUid, name: me.name || '', char: me.char || '', text, mega: true, re: re ? re.slice(0, 60) : null, ts: serverTimestamp() };
  try { await Promise.all(others.map((u) => push(R(room, 'notes', u), payload))); }
  catch (e) { toast(friendlyError(e)); return false; }
  const meP = pets.get(myUid);
  if (meP && !meP.hidden) { meP.playOnce('send', 1300); meP.say('📢 ' + text.slice(0, 20) + (text.length > 20 ? '…' : ''), 3000); }
  play('note_arrive', 0.8);
  const off = others.filter((u) => !online[u]).length;
  toast(`📢 모두에게 외쳤어요!${off ? ` (꺼져 있는 ${off}명은 켜면 받아요)` : ''}`);
  return true;
}
// 받은 확성기: 화면 가운데에 바로 떠요. 종이를 누르면 닫히고, [답장]을 누르면 바로 써요.
function megaArrived(id, data) {
  const n = { id, data, el: null, lx: W / 2 };
  notes.set(id, n);
  play('note_arrive', 0.9);
  const c = charById(data.char);
  const txt = el('div', { class: 'mtxt', text: data.text || '' });
  const re = data.re ? el('div', { class: 'mre', text: `↩ ${data.re}` }) : null;
  const lbl = el('span', { class: 'mlbl' }, el('img', { src: `assets/${c.face}` }), `📢 ${data.name || '친구'}의 확성기 · 클릭하면 닫혀요`);
  const replyBtn = el('button', { class: 'primary' }, '답장');
  const { wrap, sheet } = megaSheet([re, txt], [lbl, replyBtn]);
  wrap.dataset.kind = 'note';
  const stacked = openPops.filter((p) => p !== wrap && p.classList.contains('mwrap')).length;
  if (stacked) { wrap.style.left = (parseFloat(wrap.style.left) + stacked * 24) + 'px'; wrap.style.top = (parseFloat(wrap.style.top) + stacked * 24) + 'px'; }
  let writing = false;
  sheet.addEventListener('click', () => { if (!writing) crumple(wrap, n); });
  const bar = replyBtn.parentElement;
  replyBtn.onclick = () => {
    writing = true;
    const ta = el('textarea', { class: 'mta', maxlength: LIMITS.NOTE_MAX, placeholder: '모두에게 답장 (200자)' });
    const send = el('button', { class: 'primary' }, '📢 모두에게 답장');
    const cancel = el('button', {}, '취소');
    txt.replaceWith(ta); if (re) re.remove();
    sheet.prepend(el('div', { class: 'mre', text: `↩ ${(data.text || '').slice(0, 60)}` }));
    bar.replaceChildren(el('span', { class: 'mlbl', text: '✏️ 답장 쓰는 중' }), cancel, send);
    const back = (doneText) => {
      writing = false; sheet.replaceChildren(...[re, txt].filter(Boolean));
      bar.replaceChildren(doneText ? el('span', { class: 'mlbl sent', text: `${doneText} · 클릭하면 닫혀요` }) : lbl, ...(doneText ? [] : [replyBtn]));
    };
    cancel.onclick = () => back(null);
    send.onclick = async () => {
      const text = ta.value.trim().slice(0, LIMITS.NOTE_MAX);
      if (!text) { ta.focus(); return; }
      send.disabled = true;
      if (await sendMega(text, data.text)) back('모두에게 답장했어요 ✓'); else send.disabled = false;
    };
    window.api.focusPet(); setTimeout(() => ta.focus(), 50);
  };
}

// ---------------------------------------------------------------- 장난 (뿅망치·콕·간지럼·물풍선·바나나·이름표)
const nameTags = {};            // uid → { text, until, from }
const bananas = new Map();      // 'from>to' → { el, from, to, x, until }
const BANANA_MS = 30 * 60 * 1000, NAMETAG_MS = 3 * 60 * 1000;
function prankReady(toUid) {
  const now = Date.now();
  if (now - lastThrow < LIMITS.THROW_COOLDOWN) { toast('조금만 쉬었다 해요 (3초)'); return false; }
  if (status[toUid]?.dnd) { toast(`${nameOf(toUid)}님은 방해금지 중이에요 🔕`); return false; }
  lastThrow = now; return true;
}
function fxImg(cls, name, x, y, ms) {
  const e = el('div', { class: `emo ${cls}`, style: { left: x + 'px', top: y + 'px' } }, el('img', { src: `assets/props/${name}.png`, draggable: 'false' }));
  stage.append(e); setTimeout(() => e.remove(), ms); return e;
}
function fx(cls, text, x, y, ms) {
  const e = el('div', { class: `emo ${cls}`, text, style: { left: x + 'px', top: y + 'px' } });
  stage.append(e); setTimeout(() => e.remove(), ms); return e;
}
function requestPrank(toUid, kind) {
  if (!prankReady(toUid)) return;
  animatePrank(myUid, toUid, kind);
  sendEvent(onlineOthers(), { type: 'prank', to: toUid, kind });
}
function prankToast(fromUid, toUid, what) {
  if (toUid === myUid && fromUid !== myUid) toast(`${nameOf(fromUid)}님이 ${what}`, members[fromUid]?.char);
}
function animatePrank(fromUid, toUid, kind) {
  const pet = pets.get(toUid);
  if (!pet || pet.hidden) return;
  if (toUid === myUid && config.dnd) return;
  const top = GROUND - pet.y - FOOT;
  if (kind === 'hammer') {
    fxImg('hammer', 'toy_hammer', pet.x + 80, top + D * 0.40, 900);
    setTimeout(() => {
      play('can_hit', 0.9);
      pet.held = false; pet.falling = false; pet.y = 0;
      pet.playOnce('hitPoop', 1600); voice(pet.charId, 'hit', 0.8); // 머리 위 표시가 없는 찡그린 얼굴
    }, 300);
    prankToast(fromUid, toUid, '뿅망치로 뿅! 🔨 때렸어요!');
  } else if (kind === 'poke') {
    const side = pet.x > W / 2 ? 1 : -1;            // 화면 안쪽에서 찔러요
    const f = fxImg(`poke${side > 0 ? ' r' : ''}`, 'poke_finger', pet.x + side * 72, top + D * 0.62, 900);
    f.style.setProperty('--dx', `${-side * 26}px`);
    setTimeout(() => {
      voice(pet.charId, 'pickup', 0.8);
      if (!pet.held) { pet.targetX = null; pet.until = 0; pet.set('startle'); pet.falling = true; pet.vy = 520; pet.y = Math.max(pet.y, 1); }
    }, 320);
    prankToast(fromUid, toUid, '콕 찔렀어요! 👉');
  } else if (kind === 'tickle') {
    fxImg('feather', 'tickle_feather', pet.x + 50, top + D * 0.58, 1700);
    pet.playOnce('squirm', 1800);
    pet.img.classList.add('wiggle'); setTimeout(() => pet.img.classList.remove('wiggle'), 1700);
    voice(pet.charId, 'happy', 0.8);
    pet.say('히히힛 간지러워!', 1800);
    prankToast(fromUid, toUid, '간지럽혔어요! 🪶');
  }
}
function balloonHit(pet, fromUid) {
  const c = hitPoint(pet, 'can');
  fxImg('splash', 'water_splash', c.x, c.y, 700);
  play('drop', 1); play('poop', 0.5);
  pet.held = false; pet.falling = false; pet.y = 0;
  pet.playOnce('hitCan', 1500); setTimeout(() => voice(pet.charId, 'hit', 0.8), 120);
  const drops = el('div', { class: 'emo drops' }, el('img', { src: 'assets/props/wet_drops.png', draggable: 'false' }));
  stage.append(drops);
  const t0 = performance.now();
  const follow = (now) => {
    drops.style.left = pet.x + 'px'; drops.style.top = (GROUND - pet.y - FOOT + D * 0.34) + 'px';
    if (now - t0 < 3500 && drops.isConnected && !pet.hidden) requestAnimationFrame(follow); else drops.remove();
  };
  requestAnimationFrame(follow);
  if (pet.uid === myUid && fromUid !== myUid) toast(`${nameOf(fromUid)}님이 물풍선을 🎈 던졌어요!`, members[fromUid]?.char);
}

// 바나나 껍질: 친구 근처 바닥에 놓아요. 걸어가다 밟으면 꽈당. 30분 지나면 사라져요. 친구 한 명에게 1개.
function requestBanana(toUid) {
  const b = bananas.get(`${myUid}>${toUid}`);
  if (b && b.until > Date.now()) { toast(`${nameOf(toUid)}님 근처에 이미 바나나가 있어요 🍌`); return; }
  if (!prankReady(toUid)) return;
  const dx = (Math.random() < 0.5 ? -1 : 1) * Math.round(90 + Math.random() * 60);
  placeBanana(myUid, toUid, dx);
  sendEvent(onlineOthers(), { type: 'banana', to: toUid, dx });
  toast(`🍌 ${nameOf(toUid)}님 근처에 바나나 껍질을 놓았어요! (30분)`);
}
function placeBanana(fromUid, toUid, dx) {
  const pet = pets.get(toUid);
  if (!pet) return;
  if (toUid === myUid && config.dnd) return;
  const id = `${fromUid}>${toUid}`;
  removeBanana(id);
  const x = Math.max(40, Math.min(W - 40, pet.x + (Number(dx) || 100)));
  const e = el('div', { class: 'emo banana', style: { left: x + 'px', top: (GROUND + 4) + 'px' } }, el('img', { src: 'assets/props/banana_peel.png', draggable: 'false' }));
  stage.append(e);
  bananas.set(id, { el: e, from: fromUid, to: toUid, x, until: Date.now() + BANANA_MS });
  play('drop', 0.5);
}
function removeBanana(id) { const b = bananas.get(id); if (b) { b.el.remove(); bananas.delete(id); } }
function checkBananas() {
  if (!bananas.size) return;
  const now = Date.now();
  for (const [id, b] of bananas) {
    if (now > b.until) { removeBanana(id); continue; }
    const pet = pets.get(b.to);
    b.el.style.display = pet && !pet.hidden ? '' : 'none';
    if (!pet || pet.hidden || pet.busy || pet.y > 0 || pet.anim !== 'walk') continue;
    if (Math.abs(pet.x - b.x) < 16) slip(pet, id);
  }
}
function slip(pet, id) {
  const b = bananas.get(id);
  if (b) { b.el.classList.add('flyoff'); bananas.delete(id); setTimeout(() => b.el.remove(), 700); }
  pet.playOnce('slipped', 1900);
  pet.img.classList.add('slipping'); setTimeout(() => pet.img.classList.remove('slipping'), 1500);
  play('drop', 1); setTimeout(() => voice(pet.charId, 'hit', 0.8), 150);
  pet.say('꽈당!', 1600);
}

// 이름표: 6글자까지. 5분 동안 바뀌고, 본인이 자기 캐릭터를 누르면 바로 원래대로.
function openNameTag(pet) {
  const input = el('input', { maxlength: 6, placeholder: '새 이름표 (6글자)' });
  const go = () => {
    const text = input.value.trim().slice(0, 6);
    if (!text) { input.focus(); return; }
    if (!prankReady(pet.uid)) return;
    pop.remove();
    setNameTag(myUid, pet.uid, text);
    sendEvent(onlineOthers(), { type: 'nametag', to: pet.uid, text });
    toast(`🏷️ ${nameOf(pet.uid)}님 이름표를 '${text}'(으)로 바꿨어요! (3분)`);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') pop.remove(); });
  const pop = el('div', { class: 'pop hit', style: { width: '240px' } },
    el('div', { class: 'ph', text: `🏷️ ${nameOf(pet.uid)}님 이름표 바꾸기` }), input,
    el('div', { class: 'ft' }, el('button', { onclick: () => pop.remove() }, '취소'), el('button', { class: 'primary', onclick: go }, '붙이기')));
  placePop(pop, pet.x, pet.headTop() - 40);
  window.api.focusPet(); setTimeout(() => input.focus(), 50);
}
function setNameTag(fromUid, toUid, text) {
  text = String(text || '').trim().slice(0, 6);
  if (!text || !members[toUid]) return;
  if (toUid === myUid && config.dnd) return;
  const until = Date.now() + NAMETAG_MS;
  nameTags[toUid] = { text, until, from: fromUid };
  syncPets();
  play('window_open', 0.5);
  const tp = pets.get(toUid);
  if (tp && !tp.hidden && !tp.held) { setTimeout(() => { tp.playOnce('sigh', 2400); play('sigh', 0.8); tp.say('…내 이름표가?!', 2200); }, 300); }
  setTimeout(() => { if (nameTags[toUid] && nameTags[toUid].until <= Date.now() + 100) { delete nameTags[toUid]; syncPets(); } }, NAMETAG_MS + 200);
  if (toUid === myUid && fromUid !== myUid) toast(`${nameOf(fromUid)}님이 내 이름표를 '${text}'(으)로 바꿨어요! 🏷️ 3분 동안 그대로예요.`, members[fromUid]?.char, 7000);
}
function clearNameTag(uid, broadcast) {
  if (!nameTags[uid]) return;
  delete nameTags[uid];
  syncPets();
  if (broadcast) { play('window_close', 0.5); sendEvent(onlineOthers(), { type: 'nametagoff' }); toast('이름표를 원래대로 돌렸어요 🏷️'); }
}

// ---------------------------------------------------------------- 똥싸기·배부름·인생무상
function doAct(kind) {
  const now = Date.now();
  if (now - lastAct < LIMITS.ACT_COOLDOWN) return;
  lastAct = now;
  animateAct(myUid, kind);
  sendEvent(onlineOthers(), { type: 'act', kind });
}
function animateAct(uid, kind) {
  const pet = pets.get(uid);
  if (!pet || pet.hidden) return;
  pet.held = false; pet.falling = false; pet.y = 0;
  if (kind === 'poop') {
    pet.playOnce('poop', 2600);
    setTimeout(() => play('poop', 0.9), 900);
    setTimeout(() => {
      const p = el('img', { class: 'poop', src: 'assets/props/poop_item.png', style: { left: (pet.x - pet.dir * pet.facing * D * 0.3) + 'px', top: (GROUND - 50) + 'px' } });
      stage.append(p);
      setTimeout(() => { p.style.opacity = '0'; setTimeout(() => p.remove(), 650); }, 5000);
    }, 1500);
  } else if (kind === 'full') {
    pet.playOnce('full', 3000);
    setTimeout(() => play('burp', 0.9), 1000);
    setTimeout(() => pet.say('배부르다…', 2200), 900);
  } else if (kind === 'sigh') {
    pet.playOnce('sigh', 3600);
    setTimeout(() => play('sigh', 0.9), 1100);
    setTimeout(() => pet.say('인생무상…', 2600), 800);
  }
}

// ---------------------------------------------------------------- 쪽지
function paperCard(x, yBottom, children) {
  const card = el('div', { class: 'paper hit unfold' }, ...children);
  return placePop(card, x, yBottom);
}
// 받은 쪽지는 화면 한가운데에 '뽝' 하고 떠요
function centerCard(children) {
  const card = el('div', { class: 'paper hit center boom' }, ...children);
  stage.append(card);
  recenter(card);
  openPops.push(card);
  return card;
}
function recenter(card) {
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = Math.max(8, (W - w) / 2) + 'px';
  card.style.top = Math.max(8, (GROUND - h) / 2) + 'px';
}
function openCompose(toUid, replyTo = null) {
  const others = Object.keys(members).filter((u) => u !== myUid);
  if (!others.length) { toast('아직 방에 친구가 없어요. 방 코드를 알려 주세요!'); return; }
  let target = toUid || (others.length === 1 ? others[0] : null);
  const ta = el('textarea', { maxlength: LIMITS.NOTE_MAX, placeholder: '쪽지 내용 (200자)' });
  const cnt = el('span', { class: 'cnt', text: `0/${LIMITS.NOTE_MAX}` });
  ta.addEventListener('input', () => { cnt.textContent = `${ta.value.length}/${LIMITS.NOTE_MAX}`; });
  const who = el('div', { class: 'who' });
  const renderWho = () => {
    who.innerHTML = '';
    for (const u of others) {
      const m = members[u];
      who.append(el('button', { class: target === u ? 'on' : '', onclick: () => { target = u; renderWho(); } },
        el('img', { src: `assets/${charById(m.char).face}` }), m.name, online[u] ? '' : ' 💤'));
    }
  };
  if (!toUid) renderWho();
  const send = el('button', { class: 'primary' }, '✈️ 날리기');
  const pet = toUid ? pets.get(toUid) : pets.get(myUid);
  const card = paperCard(pet ? pet.x : W / 2, (pet ? pet.headTop() : GROUND) - 20, [
    el('div', { class: 'hd' }, '✉️ ', toUid ? `${nameOf(toUid)}에게 쪽지` : '누구에게 보낼까요?'),
    toUid ? null : who, ta,
    el('div', { class: 'ft' }, cnt, el('button', { onclick: () => card.remove() }, '취소'), send),
  ]);
  send.onclick = async () => {
    const text = ta.value.trim().slice(0, LIMITS.NOTE_MAX);
    if (!target) { toast('받을 친구를 골라 주세요'); return; }
    if (!text) { ta.focus(); return; }
    send.disabled = true;
    const ok = await sendNote(target, text, null);
    if (ok) { flyPaperFrom(card, target); card.remove(); } else send.disabled = false;
  };
  window.api.focusPet(); setTimeout(() => ta.focus(), 60);
}
async function sendNote(to, text, re) {
  if (Date.now() - lastNote < LIMITS.NOTE_COOLDOWN) { toast('천천히 보내 주세요'); return false; }
  lastNote = Date.now();
  const me = members[myUid] || {};
  try {
    await push(R(room, 'notes', to), { from: myUid, name: me.name || '', char: me.char || '', text, re: re ? re.slice(0, 60) : null, ts: serverTimestamp() });
  } catch (e) { toast(friendlyError(e)); return false; }
  const meP = pets.get(myUid);
  if (meP && !meP.hidden) { const tp = pets.get(to); if (tp) meP.dir = tp.x >= meP.x ? meP.facing : -meP.facing; meP.playOnce('send', 1300); }
  play('plane_fly', 0.8);
  sendEvent(onlineOthers().filter((u) => u !== to), { type: 'notesent', to });
  const st = status[to] || {};
  if (!online[to]) toast(`${nameOf(to)}님이 들어오면 도착해요 ✈️`);
  else if (st.dnd) toast(`${nameOf(to)}님은 방해금지 중이라 끝나면 도착해요 🔕`);
  else toast(`${nameOf(to)}님에게 쪽지를 날렸어요 ✈️`);
  return true;
}
// 종이비행기가 a → b 로 날아가요
function flyPlane(a, b, ms, onDone, fade = false) {
  const img = el('img', { class: 'plane', src: 'assets/props/plane_02.png' });
  stage.append(img);
  const t0 = performance.now(), flip = b.x < a.x ? -1 : 1;
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 2);
    const x = a.x + (b.x - a.x) * e, y = a.y + (b.y - a.y) * e - Math.sin(Math.PI * t) * 120;
    const fr = Math.floor(now / 140) % 2 ? 'plane_02' : 'plane_03';
    if (!img.src.endsWith(fr + '.png')) img.src = `assets/props/${fr}.png`;
    img.style.transform = `translate(${x}px, ${y}px) scaleX(${flip}) rotate(${Math.sin(now / 160) * 8}deg)`;
    if (fade) img.style.opacity = String(1 - Math.max(0, (t - 0.75) * 4));
    if (t < 1) requestAnimationFrame(step); else { img.remove(); if (onDone) onDone(); }
  };
  requestAnimationFrame(step);
}
function flyPaperFrom(card, toUid) {
  const r = card.getBoundingClientRect();
  const a = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const tp = pets.get(toUid);
  const b = tp && !tp.hidden ? tp.headCenter() : { x: a.x < W / 2 ? W + 60 : -60, y: a.y - 200 };
  flyPlane(a, b, 1100, null, true);
}
// 다른 친구 둘이 쪽지를 주고받는 모습도 보여요
function animateNoteSend(fromUid, toUid) {
  const f = pets.get(fromUid), t = pets.get(toUid);
  if (!f || f.hidden) return;
  if (t) f.dir = t.x >= f.x ? f.facing : -f.facing;
  f.playOnce('send', 1300);
  play('plane_fly', 0.4);
  const b = t && !t.hidden ? t.headCenter() : { x: f.x < W / 2 ? W + 60 : -60, y: GROUND - 300 };
  setTimeout(() => flyPlane(f.handPos(), b, 1100, null, true), 350);
}

// 받은 쪽지
function landingSpot() {
  const me = pets.get(myUid);
  const base = me && !me.hidden && !config.hide?.all ? me.x : W - 160;
  const taken = [...notes.values()].filter((n) => n.el).map((n) => n.lx);
  let x = base + 80;
  for (let i = 0; i < 12; i++) {
    const cand = base + (i % 2 ? -1 : 1) * (80 + Math.floor(i / 2) * 60);
    if (cand > 40 && cand < W - 40 && !taken.some((t) => Math.abs(t - cand) < 50)) { x = cand; break; }
  }
  return x;
}
function noteArrived(id, data, fresh) {
  if (notes.has(id)) return;
  if (data.mega) { megaArrived(id, data); return; }
  const n = { id, data, el: null, lx: 0 };
  notes.set(id, n);
  const x = landingSpot(); n.lx = x;
  const land = () => {
    if (!notes.has(id)) return;
    const c = charById(data.char);
    n.el = el('div', { class: 'landed hit', title: `${data.name || '친구'}의 쪽지`, style: { left: x + 'px', top: (GROUND - 74) + 'px' } },
      el('img', { class: 'p', src: 'assets/props/plane_01.png', draggable: 'false' }),
      el('img', { class: 'face', src: `assets/${c.face}`, draggable: 'false' }),
      el('div', { class: 'dot', text: '!' }));
    n.el.addEventListener('click', () => openNote(n));
    stage.append(n.el);
    play('note_arrive', 0.8);
  };
  if (fresh) {
    play('plane_fly', 0.7);
    const fromLeft = Math.random() < 0.5;
    flyPlane({ x: fromLeft ? -60 : W + 60, y: GROUND - 380 - Math.random() * 150 }, { x, y: GROUND - 40 }, 1700, land);
  } else land();
  const me = pets.get(myUid);
  if (me && !me.busy && fresh) setTimeout(() => me.say(`${data.name || '친구'}에게서 쪽지가 왔어요!`, 2500), 1700);
}
function openNote(n) {
  const { data } = n;
  if (n.el) { n.el.remove(); n.el = null; }
  play('note_open', 0.9);
  const me = pets.get(myUid);
  if (me && !me.hidden) { me.playOnce('read', 2600); voice(me.charId, 'happy', 0.6); }
  const c = charById(data.char);
  const time = data.ts ? new Date(data.ts - 0).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const replyBtn = el('button', {}, '↩️ 답장');
  const closeBtn = el('button', { class: 'primary' }, '닫기');
  const ft = el('div', { class: 'ft' }, replyBtn, closeBtn);
  const card = centerCard([
    el('div', { class: 'hd' }, el('img', { src: `assets/${c.face}` }), `${data.name || '친구'}의 쪽지`, el('span', { class: 't', text: time })),
    data.re ? el('div', { class: 're', text: `↩ 내 쪽지: ${data.re}` }) : null,
    el('div', { class: 'txt', text: data.text || '' }),
    ft,
  ]);
  card.dataset.kind = 'note';
  replyBtn.onclick = () => {
    replyBtn.remove();
    const ta = el('textarea', { maxlength: LIMITS.NOTE_MAX, placeholder: `${data.name || '친구'}에게 답장 (200자)` });
    const send = el('button', { class: 'primary' }, '✈️ 답장 날리기');
    const box = el('div', {}, ta, el('div', { class: 'ft' }, el('button', { onclick: () => { box.remove(); ft.prepend(replyBtn); recenter(card); } }, '취소'), send));
    card.insertBefore(box, ft);
    recenter(card);
    window.api.focusPet(); setTimeout(() => ta.focus(), 50);
    send.onclick = async () => {
      const text = ta.value.trim().slice(0, LIMITS.NOTE_MAX);
      if (!text) { ta.focus(); return; }
      send.disabled = true;
      if (await sendNote(data.from, text, data.text)) {
        flyPaperFrom(card, data.from);
        box.remove();
        ft.prepend(el('span', { class: 'sent', text: '답장을 보냈어요 ✓' }));
        recenter(card);
      } else send.disabled = false;
    };
  };
  closeBtn.onclick = () => crumple(card, n);
}
// 닫으면 쪽지가 구겨지며 사라져요
function crumple(card, n) {
  const r = card.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  card.remove();
  openPops = openPops.filter((p) => p !== card);
  play('note_crumple', 0.9);
  const img = el('img', { class: 'crumple', src: 'assets/props/note_crumple_01.png', style: { left: cx + 'px', top: cy + 'px' } });
  stage.append(img);
  const frames = [1, 2, 3, 4]; let i = 0;
  const scales = [1.35, 1.0, 0.7, 0.45];
  const tick = () => {
    if (i < frames.length) {
      img.src = `assets/props/note_crumple_0${frames[i]}.png`;
      img.style.transform = `scale(${scales[i]}) rotate(${i * 25}deg)`;
      i++; setTimeout(tick, 130);
    } else {
      // 공이 된 쪽지가 통 떨어지고 사라져요
      const t0 = performance.now(), y0 = cy, x0 = cx, vx = (Math.random() < 0.5 ? -1 : 1) * 120;
      const fall = (now) => {
        const t = (now - t0) / 1000;
        const y = Math.min(GROUND - 30, y0 - 260 * t + 0.5 * 1800 * t * t);
        img.style.left = (x0 + vx * t) + 'px'; img.style.top = y + 'px';
        img.style.transform = `scale(.45) rotate(${100 + t * 500}deg)`;
        if (t > 0.55) img.style.opacity = String(Math.max(0, 1 - (t - 0.55) * 3));
        if (t < 0.9) requestAnimationFrame(fall); else img.remove();
      };
      requestAnimationFrame(fall);
    }
  };
  tick();
  notes.delete(n.id);
  remove(R(room, 'notes', myUid, n.id)).catch(() => {});
}
function releaseDndQueue() {
  let i = 0;
  while (dndQueue.length) {
    const { id, data } = dndQueue.shift();
    setTimeout(() => noteArrived(id, data, true), (i++) * 1300);
  }
}

// ---------------------------------------------------------------- 포춘쿠키
// 오늘의 문구 정하기 (하루 1번, 같은 날 다른 친구와 겹치지 않게, 50개 다 쓰면 섞어서 다시)
async function drawFortune() {
  const today = dayKey();
  const mine = (await get(R(room, 'fortune', myUid))).val();
  if (mine && mine.day === today && Number.isInteger(mine.idx)) return { idx: mine.idx, already: true };
  const all = (await get(R(room, 'fortune'))).val() || {};
  const takenToday = new Set(Object.entries(all).filter(([u, v]) => u !== myUid && v?.day === today).map(([, v]) => v.idx));
  let deck = Array.isArray(mine?.deck) && mine.deck.length === FORTUNES.length ? mine.deck.map(Number) : shuffled(FORTUNES.length);
  let pos = Number.isInteger(mine?.pos) ? mine.pos : 0;
  let idx = null;
  for (let tries = 0; tries < FORTUNES.length * 2 && idx == null; tries++) {
    if (pos >= deck.length) { deck = shuffled(FORTUNES.length); pos = 0; }
    const cand = deck[pos++];
    if (!takenToday.has(cand) || tries >= FORTUNES.length) idx = cand;
  }
  await set(R(room, 'fortune', myUid), { day: today, idx, deck, pos, ts: Date.now() });
  return { idx, already: false };
}
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'network-timeout' })), ms))]);
}
let fortuneBusy = false;
async function openFortune() {
  if (fortuneBusy) return;
  fortuneBusy = true;
  const pet = pets.get(myUid);
  const x = Math.max(80, Math.min(W - 80, (pet && !pet.hidden ? pet.x : W / 2) + 110));
  let result;
  try { result = await withTimeout(drawFortune(), 12000); }
  catch (e) { logError('fortune', e); fortuneBusy = false; toast(`포춘쿠키를 못 가져왔어요. ${friendlyError(e)}`, null, 7000); return; }
  const face = `assets/props/fortune_cookie_${(result.idx % 6) + 1}.png`;   // 문구마다 표정이 정해져 있어요
  const text = FORTUNES[result.idx] || '…';
  if (result.already) { fortuneBusy = false; showFortunePaper(x, text, true, face); return; }
  // 쿠키가 톡 떨어지고 → 누르면 꾹 눌렸다가 종이가 쏙 나와요
  const ck = el('div', { class: 'cookie hit', style: { left: x + 'px', top: '-140px' } }, el('img', { src: face, draggable: 'false' }));
  stage.append(ck);
  play('cookie_drop', 0.8);
  const t0 = performance.now(), yEnd = GROUND - 125;
  const drop = (now) => {
    const t = Math.min(1, (now - t0) / 650);
    ck.style.top = (-140 + (yEnd + 140) * t * t) + 'px';
    if (t < 1) requestAnimationFrame(drop);
    else { ck.classList.add('wobble'); if (pet && !pet.hidden) pet.say('쿠키를 눌러서 깨 보세요!', 3000); }
  };
  requestAnimationFrame(drop);
  ck.addEventListener('mousedown', (e) => e.stopPropagation());
  ck.addEventListener('click', () => {
    if (ck.dataset.broken) return; ck.dataset.broken = '1';
    ck.classList.remove('wobble'); ck.classList.add('crack');
    if (pet) { clearTimeout(pet.sayT); pet.sayText = ''; pet.setBubble(pet.moodText); }
    play('cookie_break', 0.9);
    // 종이 조각이 쿠키에서 뽑혀 나와요
    setTimeout(() => {
      const slip = el('div', { class: 'slip', style: { left: x + 'px', top: (yEnd + 40) + 'px' } });
      stage.append(slip);
      ck.classList.add('gone');
      setTimeout(() => { slip.remove(); ck.remove(); fortuneBusy = false; showFortunePaper(x, text, false, face); if (pet && !pet.hidden) voice(pet.charId, 'happy', 0.7); }, 420);
    }, 560);
  });
  // 30초 안에 안 누르면 쿠키는 사라져요 (다시 누르면 같은 문구)
  setTimeout(() => { if (ck.isConnected && !ck.dataset.broken) { ck.remove(); fortuneBusy = false; } }, 30000);
}
function showFortunePaper(x, text, already, face) {
  const close = el('button', { class: 'x', title: '닫기', onclick: () => { play('window_close', 0.4); f.remove(); } }, '✕');
  const f = el('div', { class: 'fortune hit' },
    face ? el('img', { class: 'face', src: face, draggable: 'false' }) : null,
    el('div', { class: 'lbl', text: already ? '오늘의 포춘쿠키 · 이미 열었어요' : '오늘의 포춘쿠키' }),
    el('div', { class: 'ftxt', text }),
    el('div', { class: 'day', text: new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }) }),
    close);
  stage.append(f);
  const w = f.offsetWidth, h = f.offsetHeight;
  f.style.left = Math.max(60, Math.min(W - w - 16, x - w / 2)) + 'px';
  f.style.top = Math.max(60, GROUND - h - 150) + 'px';
  openPops.push(f);
}
function shuffled(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------------------------------------------------------------- 화면 갱신
function syncPets() {
  const hideAll = !!config.hide?.all;
  const want = new Set();
  for (const uid of Object.keys(members)) {
    const m = members[uid];
    if (!m?.char) continue;
    const isMe = uid === myUid;
    const visible = isMe ? !yielded : !!online[uid];
    if (!visible) continue;
    want.add(uid);
    let p = pets.get(uid);
    if (!p) { p = new Pet(uid, m.char); pets.set(uid, p); if (!isMe) voice(m.char, 'default', 0.5); }
    if (p.charId !== m.char) p.setChar(m.char);
    const st = status[uid] || {};
    p.hidden = isMe ? !!(config.hide?.mine || hideAll) : !!st.hidden;
    const dnd = isMe ? config.dnd : st.dnd;
    const queued = isMe && dndQueue.length ? ` ✉️${dndQueue.length}` : '';
    const nt = nameTags[uid];
    p.away = isMe ? myAway : !!away[uid];
    p.setTag((nt && nt.until > Date.now() ? nt.text : (m.name || '')) + (p.away ? ' · 자리비움' : ''), (p.away ? '💤' : '') + (dnd ? '🔕' : '') + queued);
    p.tag.classList.toggle('away', p.away);
    p.tag.classList.toggle('prank', !!(nt && nt.until > Date.now()));
    p.setBubble(st.moodDay === dayKey() ? (st.mood || '') : '');
  }
  for (const [uid, p] of pets) if (!want.has(uid)) { p.destroy(); pets.delete(uid); }
}

let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  const hideAll = !!config.hide?.all;
  for (const p of pets.values()) { p.update(dt, now); p.render(hideAll && !(p.isMe && false)); }
  checkBananas();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 연결
async function writeMyStatus() {
  if (yielded) return;
  const hidden = !!(config.hide?.mine || config.hide?.all);
  await update(R(room, 'status', myUid), { hidden, dnd: !!config.dnd, updatedAt: serverTimestamp() }).catch((e) => console.warn(e));
}

function startPresence() {
  // 연결마다 따로 기록 (presence/{uid}/{연결ID}) — 재연결 경쟁 문제를 막아요
  const off = onValue(ref(db, '.info/connected'), async (s) => {
    connected = s.val() === true;
    if (!connected || yielded || leaving) return;
    try {
      const c = push(R(room, 'presence', myUid));
      await onDisconnect(c).remove();
      await set(c, { device: config.device, ts: serverTimestamp(), away: myAway });
      myConn = c;
    } catch (e) { console.warn('presence', e); }
  });
  stoppers.push(off);
}
async function stopPresence() {
  if (myConn) { const c = myConn; myConn = null; await onDisconnect(c).cancel().catch(() => {}); await remove(c).catch(() => {}); }
}
function startInbox() {
  const q = R(room, 'inbox', myUid);
  stoppers.push(onChildAdded(q, (snap) => {
    const ev = snap.val();
    remove(snap.ref).catch(() => {});
    if (!ev || typeof ev.ts !== 'number') return;
    if (Date.now() + serverOffset - ev.ts > LIMITS.EVENT_STALE) return;  // 오래된 신호는 무시
    handleEvent(ev);
  }));
}
function startNotes() {
  const q = R(room, 'notes', myUid);
  stoppers.push(onChildAdded(q, (snap) => {
    const data = snap.val(); if (!data) return;
    const fresh = typeof data.ts === 'number' && Date.now() + serverOffset - data.ts < 60000;
    if (config.dnd) { if (!dndQueue.some((q2) => q2.id === snap.key)) dndQueue.push({ id: snap.key, data }); syncPets(); return; }
    noteArrived(snap.key, data, fresh);
  }));
  stoppers.push(onChildRemoved(q, (snap) => {
    const n = notes.get(snap.key);
    if (n) { if (n.el) n.el.remove(); notes.delete(snap.key); }
    const qi = dndQueue.findIndex((x) => x.id === snap.key); if (qi >= 0) dndQueue.splice(qi, 1);
  }));
}

// 같은 캐릭터를 두 PC에서 켜면, 나중에 켠 PC가 우선이에요
let yieldCard = null;
function startActive() {
  const aref = R(room, 'active', myUid);
  set(aref, { device: config.device, ts: serverTimestamp() }).catch(() => {});
  onValue(aref, (s) => {
    const v = s.val(); if (!v || !v.device) return;
    if (v.device !== config.device && !yielded) yieldHere();
    else if (v.device === config.device && yielded) location.reload();
  });
}
async function yieldHere() {
  yielded = true;
  stoppers.forEach((f) => { try { f(); } catch { /* */ } }); stoppers = [];
  await stopPresence();
  for (const n of notes.values()) if (n.el) n.el.remove();
  notes.clear();
  syncPets();
  yieldCard = el('div', { class: 'yield hit' }, '💻 지금은 다른 컴퓨터에서 쓰고 있어요',
    el('button', { class: 'primary', onclick: () => set(R(room, 'active', myUid), { device: config.device, ts: serverTimestamp() }) }, '여기서 쓰기'));
  stage.append(yieldCard);
}

async function main() {
  config = await window.api.getConfig();
  setSound(config.sound);
  const scr = await window.api.screenInfo();
  // 오버레이 창은 작업표시줄을 뺀 영역(workArea)만 덮어요
  W = scr.workArea.width;
  GROUND = scr.workArea.height;
  room = config.room; myUid = config.uid;

  if (!(await initFirebase())) { toast('Firebase 설정이 없어요. 설정 창에서 확인해 주세요.', null, 60000); return; }
  const u = await currentUser();
  if (!u || u.uid !== myUid) {
    const c = el('div', { class: 'yield hit' }, '🔑 로그인 정보가 없어요. 캐릭터를 다시 골라 주세요.', el('button', { class: 'primary', onclick: () => window.api.restartSetup() }, '다시 고르기'));
    stage.append(c);
    return;
  }

  onValue(ref(db, '.info/serverTimeOffset'), (s) => { serverOffset = Number(s.val()) || 0; });
  onValue(R(room, 'members'), (s) => { members = s.val() || {}; syncPets(); }, (e) => toast(friendlyError(e), null, 10000));
  onValue(R(room, 'status'), (s) => { status = s.val() || {}; syncPets(); });
  onValue(R(room, 'presence'), (s) => {
    const v = s.val() || {};
    online = Object.fromEntries(Object.entries(v).map(([k, conns]) => [k, !!conns && Object.keys(conns).length > 0]));
    // 모든 연결이 자리비움이면 자리비움
    away = Object.fromEntries(Object.entries(v).map(([k, conns]) => [k, !!conns && Object.values(conns).length > 0 && Object.values(conns).every((c) => c && c.away)]));
    syncPets();
  });
  startPresence();
  startInbox();
  startNotes();
  startActive();
  await writeMyStatus();
  play('window_open', 0.5);
  setTimeout(() => { const me = pets.get(myUid); if (me) voice(me.charId, 'default', 0.7); }, 600);
  requestAnimationFrame(loop);

  // 날짜가 바뀌면 기분 말풍선을 정리해요
  let lastDay = dayKey();
  setInterval(() => { if (dayKey() !== lastDay) { lastDay = dayKey(); syncPets(); } }, 30000);
}

window.api.onConfig(async (c) => {
  const wasDnd = !!config.dnd;
  config = c; setSound(c.sound);
  if (!room) return;
  await writeMyStatus();
  if (wasDnd && !c.dnd) { releaseDndQueue(); toast('방해금지를 껐어요'); }
  else if (!wasDnd && c.dnd) toast('🔕 방해금지: 던지기는 막고, 쪽지는 모아 둘게요');
  syncPets();
});
window.api.onUpdateReady((v) => toast(`🎁 새 버전 ${v}을 받아 두었어요. 다음에 켜면 바뀌어요!`, null, 8000));
window.api.onIdle((v) => {
  myAway = !!v;
  if (myConn) update(myConn, { away: myAway }).catch(() => {});
  syncPets();
});
window.api.onLeaving(async () => { leaving = true; await stopPresence(); });

main().catch((e) => { console.error(e); toast(friendlyError(e), null, 20000); });

// 개발용 훅 (화면 점검)
window.__pdroom = { setAway: (v) => { myAway = !!v; if (myConn) update(myConn, { away: myAway }).catch(() => {}); syncPets(); }, pets, notes, openMegaphone, requestThrow, requestPrank, requestBanana, setNameTag, nameTags, bananas, doAct, openFortune, openCompose, noteArrived, openNote, crumple, openMyMenu, openFriendMenu, sendNote, get members() { return members; } };
