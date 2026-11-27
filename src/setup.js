// 처음 실행: Firebase 설정 → 방 만들기/들어가기 → 캐릭터 고르기 + 이름
import { get, set, update, remove, onValue, runTransaction, serverTimestamp } from 'firebase/database';
import {
  initFirebase, ensureUser, fixedRoom, loginWithPassword, R, manifest, el, makeRoomCode, normalizeCode,
  friendlyError, LIMITS, auth,
} from './fb.js';
import { play, setSound } from './sound.js';

const body = document.getElementById('body');
document.getElementById('close').onclick = () => window.api.close();
let config = {};
let offs = [];
const clear = () => { offs.forEach((f) => f()); offs = []; body.innerHTML = ''; };

(async function start() {
  config = await window.api.getConfig();
  setSound(config.sound);
  play('window_open', 0.6);
  body.append(el('h2', { text: '연결하는 중이에요…' }), el('div', { class: 'muted', text: '잠시만 기다려 주세요.' }));
  const slow = setTimeout(() => {
    if (!body.querySelector('.card')) body.append(el('div', { class: 'err', text: '연결이 오래 걸려요. 인터넷 연결을 확인하거나, 프로그램을 껐다 다시 켜 주세요.' }));
  }, 15000);
  offs.push(() => clearTimeout(slow));
  const ok = await initFirebase();
  if (!ok) return showFirebasePaste();
  try { await ensureUser(); } catch (e) { return showError(e); }
  if (fixedRoom) {
    // 방이 정해져 있으면 바로 캐릭터 고르기로 (방이 아직 없으면 첫 사람이 만들어요)
    try {
      await runTransaction(R(fixedRoom, 'meta'), (cur) => (cur ? undefined : { createdAt: Date.now(), by: auth.currentUser.uid }));
    } catch (e) { return showError(e); }
    await window.api.setConfig({ room: fixedRoom });
    return showChars(fixedRoom);
  }
  if (config.room) return showChars(config.room);
  showRoom();
})();

function showError(e) {
  clear();
  body.append(el('h2', { text: '연결하지 못했어요' }), el('div', { class: 'err', text: friendlyError(e) }),
    el('button', { onclick: () => location.reload() }, '다시 시도'));
}

// ① Firebase 설정이 없을 때: 콘솔에서 복사한 설정을 붙여 넣어요
function showFirebasePaste() {
  clear();
  const ta = el('textarea', { placeholder: "const firebaseConfig = {\n  apiKey: \"...\",\n  authDomain: \"...\",\n  databaseURL: \"...\",\n  ...\n};" });
  const err = el('div', { class: 'err' });
  body.append(
    el('h2', { text: 'Firebase 설정 붙여넣기' }),
    el('div', { class: 'muted', text: '방장이 알려 준 Firebase 설정(firebaseConfig로 시작하는 글)을 통째로 붙여 넣어 주세요. 한 번만 하면 돼요.' }),
    ta, err,
    el('div', { class: 'row' }, el('span', { style: { flex: 1 } }), el('button', {
      class: 'primary',
      onclick: async () => {
        const cfg = parseFirebaseConfig(ta.value);
        if (!cfg) { err.textContent = 'apiKey와 databaseURL을 찾지 못했어요. 전체를 다시 복사해 주세요.'; return; }
        await window.api.saveFirebase(cfg);
        location.reload();
      },
    }, '저장하고 계속')),
  );
}
export function parseFirebaseConfig(text) {
  const keys = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
  const out = {};
  for (const k of keys) {
    const m = String(text).match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`));
    if (m) out[k] = m[1].trim();
  }
  return out.apiKey && out.databaseURL ? out : null;
}

// ② 방 만들기 / 들어가기
function showRoom() {
  clear();
  const code = el('input', { maxlength: 6, placeholder: '예: K7P2QX', style: { textTransform: 'uppercase', letterSpacing: '4px', fontWeight: 800, fontSize: '18px' } });
  const err = el('div', { class: 'err' });
  const make = el('button', { class: 'primary' }, '✨ 새 방 만들기');
  const join = el('button', { class: 'primary' }, '🚪 들어가기');
  make.onclick = async () => {
    make.disabled = true; err.textContent = '';
    try {
      const me = auth.currentUser;
      for (let i = 0; i < 5; i++) {
        const c = makeRoomCode();
        const r = await runTransaction(R(c, 'meta'), (cur) => (cur ? undefined : { createdAt: Date.now(), by: me.uid }));
        if (r.committed) { await window.api.setConfig({ room: c }); return showChars(c); }
      }
      err.textContent = '방을 만들지 못했어요. 다시 눌러 주세요.';
    } catch (e) { err.textContent = friendlyError(e); }
    make.disabled = false;
  };
  join.onclick = async () => {
    const c = normalizeCode(code.value);
    if (c.length !== 6) { err.textContent = '방 코드는 6자리예요.'; return; }
    join.disabled = true; err.textContent = '';
    try {
      const s = await get(R(c, 'meta'));
      if (!s.exists()) err.textContent = '그런 방이 없어요. 코드를 다시 확인해 주세요.';
      else { await window.api.setConfig({ room: c }); return showChars(c); }
    } catch (e) { err.textContent = friendlyError(e); }
    join.disabled = false;
  };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join.click(); });
  body.append(
    el('h2', { text: '친구들과 함께 쓸 방을 정해요' }),
    el('div', { class: 'split' },
      el('div', { class: 'box' }, el('b', { text: '처음이라면' }), el('div', { class: 'muted', text: '방을 만들면 6자리 코드가 생겨요. 친구 3명에게 코드를 알려 주세요.' }), make),
      el('div', { class: 'box' }, el('b', { text: '코드를 받았다면' }), code, join),
    ),
    err,
  );
}

// ③ 캐릭터 고르기
function showChars(room) {
  clear();
  let claims = {}, members = {}, selected = null, pwFor = null;
  const me = () => auth.currentUser;
  const name = el('input', { maxlength: LIMITS.NAME_MAX, placeholder: '이름 (12자까지)', value: config.name || '' });
  const err = el('div', { class: 'err' });
  const go = el('button', { class: 'primary' }, '시작하기');
  const pwInput = el('input', { type: 'password', placeholder: '이 캐릭터의 비밀번호' });
  const pwGo = el('button', { class: 'primary' }, '들어가기');
  const pwCancel = el('button', {}, '취소');
  const pwBox = el('div', { class: 'row pw' }, pwInput, pwGo, pwCancel);
  const cards = el('div', { class: 'cards' });

  const render = () => {
    cards.innerHTML = '';
    for (const c of manifest.characters) {
      const owner = claims[c.id];
      const mine = owner && owner === me()?.uid;
      const sold = owner && !mine;
      const m = owner ? members[owner] : null;
      const card = el('div', { class: `card${selected === c.id ? ' sel' : ''}${sold ? ' sold' : ''}` },
        el('img', { src: `assets/${c.card}`, alt: c.label, draggable: 'false', style: c.cardInset ? { objectViewBox: `inset(${c.cardInset.map((n) => n + 'px').join(' ')})` } : null }),
        el('div', { class: 'nm', text: c.label }),
        el('div', { class: 'owner', text: mine ? '내 캐릭터' : m ? m.name : '' }),
        sold ? el('div', { class: 'stamp', text: '품절' }) : null);
      card.onclick = () => {
        err.textContent = '';
        if (sold) {
          if (m?.linked) { pwFor = { char: c.id, owner }; pwBox.classList.add('show'); pwInput.value = ''; pwInput.focus(); selected = null; }
          else { err.textContent = `${m?.name || '다른 친구'}님이 고른 캐릭터예요. (비밀번호를 설정하면 다른 PC에서도 쓸 수 있어요)`; pwBox.classList.remove('show'); }
        } else { selected = c.id; pwFor = null; pwBox.classList.remove('show'); play('drop', 0.4); }
        render();
      };
      cards.append(card);
    }
  };
  offs.push(onValue(R(room, 'claims'), (s) => { claims = s.val() || {}; if (!selected) { const mineId = Object.keys(claims).find((k) => claims[k] === me()?.uid); if (mineId) selected = mineId; } render(); }, (e) => { err.textContent = friendlyError(e); }));
  offs.push(onValue(R(room, 'members'), (s) => { members = s.val() || {}; render(); }));

  go.onclick = async () => {
    const nm = name.value.trim().slice(0, LIMITS.NAME_MAX);
    if (!selected) { err.textContent = '캐릭터를 골라 주세요.'; return; }
    if (!nm) { err.textContent = '이름을 적어 주세요.'; return; }
    go.disabled = true; err.textContent = '';
    try {
      const uid = me().uid;
      const r = await runTransaction(R(room, 'claims', selected), (cur) => (!cur || cur === uid ? uid : undefined));
      if (!r.committed) { err.textContent = '방금 다른 친구가 골랐어요. 다른 캐릭터를 골라 주세요.'; go.disabled = false; return; }
      // 예전에 갖고 있던 다른 캐릭터는 놓아 줘요
      for (const [k, v] of Object.entries(claims)) if (v === uid && k !== selected) await remove(R(room, 'claims', k)).catch(() => {});
      await update(R(room, 'members', uid), { name: nm, char: selected, joinedAt: Date.now() });
      await set(R(room, 'status', uid, 'updatedAt'), serverTimestamp()).catch(() => {});
      finish({ room, uid, char: selected, name: nm });
    } catch (e) { err.textContent = friendlyError(e); go.disabled = false; }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });

  pwCancel.onclick = () => { pwFor = null; pwBox.classList.remove('show'); };
  pwGo.onclick = async () => {
    if (!pwFor) return;
    pwGo.disabled = true; err.textContent = '';
    try {
      const u = await loginWithPassword(pwFor.owner, pwInput.value);
      if (u.uid !== pwFor.owner) throw new Error('다른 계정이에요');
      const m = (await get(R(room, 'members', u.uid))).val() || {};
      finish({ room, uid: u.uid, char: pwFor.char, name: m.name || '친구' });
    } catch (e) { err.textContent = friendlyError(e); pwGo.disabled = false; }
  };
  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwGo.click(); });

  body.append(
    el('div', { class: 'row' }, el('h2', { text: '캐릭터를 골라요' }), el('span', { style: { flex: 1 } }),
      fixedRoom ? null : el('span', { class: 'muted', text: '방 코드' }),
      fixedRoom ? null : el('span', { class: 'code', style: { fontSize: '18px', letterSpacing: '3px' }, text: room }),
      fixedRoom ? null : el('button', { title: '다른 방으로', onclick: async () => { await window.api.setConfig({ room: null }); showRoom(); } }, '방 바꾸기')),
    cards, pwBox,
    el('div', { class: 'row' }, name, go),
    err,
  );
  render();
}

function finish(data) {
  play('window_close', 0.6);
  window.api.setupDone(data);
}

// 개발용 훅
window.__pdroomSetup = { parseFirebaseConfig };
