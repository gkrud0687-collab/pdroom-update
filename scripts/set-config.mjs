// Firebase 콘솔에서 복사한 firebaseConfig 글을 build-config.json으로 바꿔요.
// 사용: node scripts/set-config.mjs <붙여넣은 글이 든 파일> [방코드]
import fs from 'node:fs';
const text = fs.readFileSync(process.argv[2], 'utf8');
const keys = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
const firebase = {};
for (const k of keys) {
  const m = text.match(new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`));
  if (m) firebase[k] = m[1].trim();
}
if (!firebase.apiKey || !firebase.databaseURL) { console.error('apiKey 또는 databaseURL이 없어요'); process.exit(1); }
const old = (() => { try { return JSON.parse(fs.readFileSync('build-config.json', 'utf8')); } catch { return {}; } })();
const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const room = process.argv[3] || old.room || Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join('');
fs.writeFileSync('build-config.json', JSON.stringify({ firebase, room }, null, 2));
console.log('build-config.json 저장', firebase.projectId, '방', room);
