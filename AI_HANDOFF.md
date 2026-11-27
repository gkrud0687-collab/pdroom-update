# 우가우가 (내부 이름 PDRoom, 예전 이름 피디들 방) — 다른 AI에게 수정을 맡길 때 처음 붙여 넣는 설명

> 이 글을 다른 AI(ChatGPT, Gemini 등)에게 소스 zip과 함께 먼저 붙여 넣어 주세요.
> 버전: 0.3.4 (2026-11-27)

## 1. 이 프로그램은 무엇인가요
- 친구 4명이 각자 Windows PC에서 켜는 **바탕화면 캐릭터 앱**입니다. 캐릭터(원숭이 monkey, 흰 족제비 ferret, 해달 otter, 사막여우 fennec)가 화면 아래를 걸어 다닙니다.
- 친구끼리 실시간으로 연결됩니다: 기분 말풍선, 던지기(깡통·똥·번개·물풍선), 장난(뿅망치·콕·간지럼·바나나 껍질·이름표), 종이비행기 쪽지(답장, 닫으면 구겨짐, 꺼져 있을 때 보관), 포춘쿠키(하루 1번), 똥싸기·배부름·인생무상, 방해금지, 숨기기, 자동 실행, 소리 설정, 비밀번호로 두 번째 PC 연결.
- 기술: **Electron 38** (Windows 데스크톱 앱) + **Firebase** (익명 로그인 + Realtime Database). 화면 코드는 esbuild로 묶습니다.

## 2. 폴더 구조
| 파일 / 폴더 | 하는 일 |
|---|---|
| `main.js` | 메인 프로세스. 창 3개(setup 처음 화면, pet 투명 캐릭터 화면, settings 설정), 트레이 메뉴, 설정 파일 저장, 자동 실행 |
| `preload.js` | 화면 코드가 쓰는 `window.api` (메인과 통신) |
| `setup.html` + `src/setup.js` | 처음 실행: 캐릭터 고르기 + 이름, 비밀번호로 다른 PC 로그인 |
| `pet.html` + `src/pet.js` | 화면 전체를 덮는 투명 창. 캐릭터·메뉴·던지기·장난·쪽지·포춘쿠키 전부. CSS 애니메이션도 `pet.html` 안에 있음 |
| `settings.html` + `src/settings.js` | 설정 창 |
| `src/fb.js` | Firebase 연결, 로그인, 경로 함수 `R(room, ...)`, 제한값 `LIMITS` |
| `src/sound.js` | 효과음·캐릭터 목소리 재생 |
| `style.css` | 공통 색(라벤더) |
| `assets/manifest.json` | 캐릭터별 동작 → 그림 파일 매핑 (자동 생성: `scripts/make-manifest.mjs`) |
| `assets/characters/<캐릭터>/` | 캐릭터 그림 (512×512 투명 PNG, 발바닥 y=450) |
| `assets/props/` | 물건 그림 (512×512 투명 PNG) |
| `assets/sounds/` | 효과음 .wav |
| `assets/fortunes/` | 포춘쿠키 문구 50개 → 빌드 때 `src/gen/fortunes.json`으로 변환 |
| `assets/app_icon.png`, `build/icon.ico` | 프로그램 아이콘 |
| `firebase-rules.json` | Firebase Realtime Database 보안 규칙 (콘솔에 붙여 넣어 게시함) |
| `build-config.json` | **Firebase 설정 + 고정 방 코드**. 공유용 zip에는 빠져 있음 (아래 5번) |
| `scripts/` | build(묶기), check-config(설정 확인), set-config(설정 파일 만들기), after-pack(exe 아이콘 넣기) |

## 3. 데이터 구조 (Firebase Realtime Database)
모두 `rooms/{6자리 방 코드}/` 아래에 있습니다.
- `meta` 방 정보, `claims/{캐릭터}` 누가 그 캐릭터를 골랐는지, `members/{uid}` 이름·캐릭터
- `status/{uid}` 기분·숨김·방해금지, `presence/{uid}` 접속 표시, `active/{uid}` 마지막으로 켠 PC
- `inbox/{uid}` 실시간 신호(던지기·장난·쪽지 보냄 등, 60초 지나면 무시). **장난은 전부 이 신호로만 오가서 켜져 있는 친구에게만 보입니다** (사용자가 이렇게 정함)
- `notes/{uid}` 받은 쪽지 (닫을 때 지움), `fortune/{uid}` 오늘의 포춘쿠키
- 새 경로를 추가하면 `firebase-rules.json`도 고치고 Firebase 콘솔에 다시 게시해야 합니다.

## 4-0. 새 버전 내기 (자동 업데이트, 0.3.0부터)
- 공개 저장소 github.com/gkrud0687-collab/pdroom-update 의 GitHub Actions(`.github/workflows/release.yml`, Windows)가 설치 파일(PDRoom-Setup-x.exe)을 만들어 Releases에 올립니다. 저장소 Secret `BUILD_CONFIG`에 build-config.json 내용이 들어 있어요.
- 순서: `package.json`의 version 올리기 → main에 push → Actions에서 release 워크플로 실행(Run workflow).
- 앱은 electron-updater로 15초 뒤·2시간마다 확인 → 받아 두고 "🎁 새 버전" 압정 종이를 띄움(지금 다시 켜기/나중에). 업데이트 후 첫 실행에 "🎉 업데이트됐어요" 1회.
- **appId(com.pdroom.app), productName(PDRoom), 저장 폴더 이름은 바꾸면 안 됩니다.** 바꾸면 자동 업데이트가 끊기고 캐릭터 선택이 처음부터 다시 나와요. 화면에 보이는 이름(우가우가)만 바꿀 수 있어요.

## 4. 만들기(빌드) 방법 — Windows PC에서
1. Node.js(LTS)를 설치합니다.
2. 소스 폴더에 `build-config.json`을 넣습니다 (따로 보관한 파일).
3. 소스 폴더에서 명령 창을 열고 `npm install` (처음 한 번)
4. 시험 실행: `npm start`
5. 배포 파일 만들기: `npm run dist` → `release/PDRoom-<버전>-win.zip`
6. 버전은 `package.json`의 `"version"`을 올립니다.

## 5. 꼭 지켜야 할 규칙
- **`build-config.json`의 방 코드(`room`)를 바꾸면 안 됩니다.** 바꾸면 친구들이 다른 방에 들어가서 서로 안 보입니다.
- **그림 규격**: 512×512 투명 PNG. 캐릭터 그림은 발바닥이 y=450에 오게. 캐릭터 그림을 바꾸면 `node scripts/make-manifest.mjs`로 manifest를 다시 만듭니다. 원숭이만 파일 이름 규칙이 다릅니다(예: `monkey_can_hit_01.png`, 다른 캐릭터는 `ferret_hit_can_01.png`).
- **화면 효과는 단순하게**: 사용자는 효과가 겹치는 걸 싫어합니다. 맞는 물건은 머리에 닿게, 약 1초. 어지러움 표시·화면 번쩍임은 일부러 뺐습니다.
- **받은 쪽지**는 화면 정가운데에 뜨고 벨처럼 1초 흔들립니다. 닫으면 구겨지며 사라집니다.
- 확성기(📢)는 모두에게, 쪽지는 친구 캐릭터를 눌러 한 명에게. 이름표는 3분 고정. 마우스·키보드 3분 무활동이면 자리비움. "그대로 멈춰라"는 내 화면만 멈춤(config.freeze).
- 캐릭터 위치는 PC마다 따로 계산됩니다(서로 같은 자리에 있지 않음).
- 사용자는 개발자가 아닙니다. 설명은 쉽게, 바꾼 점은 짧게 정리해 주세요.

## 6. 이미 알려진 한계
- 효과음 일부(뿅망치·물풍선·꽈당 등)는 아직 기존 소리를 돌려 씁니다.
- 바나나·이름표는 앱을 껐다 켜면 사라집니다(의도된 동작).
- Windows 실제 환경에서는 사용자가 직접 확인합니다. 오류 기록은 `%APPDATA%\PDRoom\log.txt`.
