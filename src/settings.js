// 설정 창: 소리, 자동 실행, 방해금지, 숨기기, 다른 PC용 비밀번호, 방 코드, 캐릭터 바꾸기, 종료
import { update, get } from 'firebase/database';
import { initFirebase, currentUser, linkPassword, R, charById, el, friendlyError } from './fb.js';
import { play, setSound } from './sound.js';

const body = document.getElementById('body');
document.getElementById('close').onclick = () => { play('window_close', 0.4); window.api.close(); };
let config = {};

function sw(checked, onchange) {
  const i = el('input', { type: 'checkbox' }); i.checked = !!checked;
  i.addEventListener('change', () => onchange(i.checked));
  return el('label', { class: 'sw' }, i, el('span'));
}
const opt = (label, control, sub) => el('div', { class: 'opt' }, el('div', {}, label, sub ? el('div', { class: 'muted', text: sub }) : null), control);

async function render() {
  config = await window.api.getConfig();
  setSound(config.sound);
  const c = charById(config.char);
  const auto = await window.api.getAutoLaunch();
  body.innerHTML = '';

  const vol = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: config.sound?.volume ?? 0.8, style: { width: '140px' } });
  vol.addEventListener('change', async () => { await window.api.setConfig({ sound: { ...(config.sound || {}), volume: Number(vol.value) } }); config = await window.api.getConfig(); setSound(config.sound); play('note_arrive', 1); });

  const pw = el('input', { type: 'password', placeholder: '6자 이상' });
  const pwMsg = el('div', { class: 'ok' });
  const pwBtn = el('button', { class: 'primary' }, '비밀번호 정하기');
  const pwSec = el('div', { class: 'sec' }, el('h3', { text: '🔑 다른 컴퓨터에서도 쓰기' }));

  body.append(
    el('div', { class: 'sec' },
      el('div', { class: 'me' }, el('img', { src: `assets/${c.face}` }), el('div', {}, el('b', { text: config.name || '' }), el('div', { class: 'muted', text: c.label }))),
      el('div', { class: 'opt' }, el('div', {}, '방 코드'), el('span', { class: 'code', text: config.room || '' }))),
    el('div', { class: 'sec' }, el('h3', { text: '🔊 소리' }),
      opt('효과음 켜기', sw(config.sound?.on !== false, (v) => window.api.setConfig({ sound: { ...(config.sound || {}), on: v } }))),
      opt('음량', vol)),
    el('div', { class: 'sec' }, el('h3', { text: '🐾 캐릭터' }),
      opt('방해금지', sw(config.dnd, (v) => window.api.setConfig({ dnd: v })), '던지기를 막고, 쪽지는 모아 뒀다가 끄면 도착해요'),
      opt('내 캐릭터 숨기기', sw(config.hide?.mine, (v) => window.api.setConfig({ hide: { ...(config.hide || {}), mine: v } }))),
      opt('모든 캐릭터 숨기기', sw(config.hide?.all, (v) => window.api.setConfig({ hide: { ...(config.hide || {}), all: v } })), '친구 화면에서도 내 캐릭터가 안 보여요')),
    el('div', { class: 'sec' }, el('h3', { text: '💻 컴퓨터' }),
      opt('컴퓨터를 켜면 자동 실행', sw(auto, async (v) => { await window.api.setAutoLaunch(v); }))),
    pwSec,
    el('div', { class: 'sec' },
      el('div', { class: 'row' },
        el('button', { onclick: (e) => { if (confirmStep(e.currentTarget, '정말 바꿀까요?')) window.api.restartSetup(); } }, '캐릭터·이름 바꾸기'),
        el('span', { style: { flex: 1 } }),
        el('button', { class: 'danger', onclick: () => window.api.quit() }, '프로그램 종료'))),
  );

  // 비밀번호 영역
  const okFb = await initFirebaseOnce();
  if (!okFb) { pwSec.append(el('div', { class: 'muted', text: 'Firebase 연결이 없어요.' })); return; }
  const linked = (await get(R(config.room, 'members', config.uid, 'linked')).catch(() => null))?.val();
  if (linked) {
    pwSec.append(el('div', { class: 'muted', text: '비밀번호가 설정돼 있어요. 다른 컴퓨터의 처음 화면에서 품절된 내 캐릭터를 누르고 비밀번호를 넣으면 돼요.' }));
  } else {
    pwSec.append(el('div', { class: 'muted', text: '비밀번호를 정해 두면, 다른 컴퓨터에서 같은 캐릭터로 들어갈 수 있어요. (잊으면 찾을 수 없으니 꼭 기억해 주세요)' }), el('div', { class: 'row' }, pw, pwBtn), pwMsg);
    pwBtn.onclick = async () => {
      if (pw.value.length < 6) { pwMsg.style.color = 'var(--red)'; pwMsg.textContent = '6자 이상으로 정해 주세요.'; return; }
      pwBtn.disabled = true;
      try {
        const u = await currentUser();
        if (!u || u.uid !== config.uid) throw new Error('로그인 정보가 맞지 않아요');
        await linkPassword(pw.value);
        await update(R(config.room, 'members', config.uid), { linked: true });
        pwMsg.style.color = ''; pwMsg.textContent = '비밀번호를 정했어요 ✓';
        play('note_arrive', 0.7);
      } catch (e) { pwMsg.style.color = 'var(--red)'; pwMsg.textContent = friendlyError(e); pwBtn.disabled = false; }
    };
  }
}
let fbReady = null;
function initFirebaseOnce() { if (!fbReady) fbReady = initFirebase(); return fbReady; }
function confirmStep(button, text) {
  if (button.dataset.armed) return true;
  button.dataset.armed = '1'; const old = button.textContent; button.textContent = text;
  setTimeout(() => { delete button.dataset.armed; button.textContent = old; }, 3000);
  return false;
}

window.api.onConfig(() => { /* 다른 창에서 바뀌면 다시 그려요 */ render(); });
render();
