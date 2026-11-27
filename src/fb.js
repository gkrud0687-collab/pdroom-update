// Firebase 연결과 공통 도구
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
  EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword,
} from 'firebase/auth';
import { getDatabase, connectDatabaseEmulator, ref } from 'firebase/database';
import manifest from '../assets/manifest.json';

export { manifest };
export const CHARS = manifest.characters.map((c) => c.id);
export const charById = (id) => manifest.characters.find((c) => c.id === id) || manifest.characters[0];

export const LIMITS = {
  NAME_MAX: 12, MOOD_MAX: 30, NOTE_MAX: 200,
  THROW_COOLDOWN: 3000, ACT_COOLDOWN: 4000, NOTE_COOLDOWN: 2000,
  EVENT_STALE: 60000,
};

export let app = null, auth = null, db = null;
export let fixedRoom = null;   // 빌드에 넣어 둔 방 코드 (있으면 방 고르기 화면을 건너뛰어요)

// 메인 프로세스에서 Firebase 설정을 받아 초기화해요. 설정이 없으면 null.
export async function initFirebase() {
  const { config, emulator, room } = await window.api.getFirebase();
  fixedRoom = room || null;
  let cfg = config;
  if (!cfg && emulator) cfg = { apiKey: 'demo-key', projectId: 'demo-pdroom', databaseURL: `http://${emulator}?ns=demo-pdroom` };
  if (!cfg) return false;
  app = initializeApp(cfg);
  auth = getAuth(app);
  db = getDatabase(app);
  if (emulator) {
    const [host, port] = emulator.split(':');
    connectDatabaseEmulator(db, host, Number(port));
    connectAuthEmulator(auth, `http://${host}:${process_env_auth_port(emulator)}`, { disableWarnings: true });
  }
  return true;
}
// 에뮬레이터: DB 포트 + 1 을 인증 포트로 써요 (테스트 전용)
function process_env_auth_port(emu) { return Number(emu.split(':')[1]) + 1; }

export function currentUser() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });
}
export async function ensureUser() {
  const u = await currentUser();
  if (u) return u;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

// 다른 PC에서 들어가기 위한 내부 이메일 주소 (실제 메일함 아님)
export const emailFor = (uid) => `u${String(uid).toLowerCase()}@pdroom.example.com`;
export async function linkPassword(pw) {
  const u = auth.currentUser;
  const cred = EmailAuthProvider.credential(emailFor(u.uid), pw);
  await linkWithCredential(u, cred);
}
export async function loginWithPassword(ownerUid, pw) {
  const cred = await signInWithEmailAndPassword(auth, emailFor(ownerUid), pw);
  return cred.user;
}

// 방 안의 경로
export const R = (room, ...parts) => ref(db, ['rooms', room, ...parts].join('/'));

// 방 코드: 헷갈리는 글자(0,O,1,I) 빼고 6자리
export function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = new Uint32Array(6); crypto.getRandomValues(buf);
  for (const n of buf) s += A[n % A.length];
  return s;
}
export const normalizeCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

// 오늘 날짜(내 PC 시간 기준) YYYY-MM-DD
export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 작은 DOM 도우미
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

export function friendlyError(e) {
  const code = e?.code || '';
  if (code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('invalid-login')) return '비밀번호가 맞지 않아요.';
  if (code.includes('too-many-requests')) return '너무 여러 번 시도했어요. 잠시 뒤에 다시 해 주세요.';
  if (code.includes('weak-password')) return '비밀번호는 6자 이상이어야 해요.';
  if (code.includes('network') || code.includes('timeout')) return '인터넷 연결을 확인해 주세요.';
  if (code.includes('PERMISSION_DENIED') || String(e?.message).includes('permission')) return '권한이 없어요. Firebase 규칙을 게시했는지 확인해 주세요.';
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted')) return 'Firebase에서 로그인 방식(익명, 이메일/비밀번호)을 켜 주세요.';
  return `문제가 생겼어요 (${code || e?.message || e})`;
}
