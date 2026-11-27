// 배포용 zip을 만들기 전에 Firebase 설정이 들어 있는지 확인해요.
import fs from 'node:fs';
let c = {};
try { c = JSON.parse(fs.readFileSync('build-config.json', 'utf8')); } catch { /* 없음 */ }
if (!c.firebase?.apiKey || !c.firebase?.databaseURL || !c.room) {
  console.error('build-config.json이 없어요. 먼저 node scripts/set-config.mjs <firebaseConfig 글 파일> 을 실행해 주세요.');
  process.exit(1);
}
console.log('설정 확인:', c.firebase.projectId, '방', c.room);
