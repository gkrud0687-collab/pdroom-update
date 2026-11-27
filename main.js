// 우가우가 — 메인 프로세스
// 창: 처음 설정(setup), 캐릭터 오버레이(pet), 설정(settings). 트레이 메뉴, 로컬 설정 파일, 자동 실행.
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 개발·테스트용: 한 PC에서 여러 명을 흉내 낼 때 프로필 폴더를 나눠요.
if (process.env.PDROOM_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), 'pd-room-' + process.env.PDROOM_PROFILE));
}
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// 작업표시줄 메뉴의 '우가우가 끄기'는 --quit 으로 실행돼요. 켜져 있는 앱이 없으면 그냥 끝내요.
if (process.argv.includes('--quit')) { app.quit(); process.exit(0); }

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
let config = {};
function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')); } catch { config = {}; }
  if (!config.device) { config.device = crypto.randomUUID(); saveConfig(); }
}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true }); fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2)); } catch (e) { console.error(e); }
}

// Firebase 설정 찾기: ① exe 옆(또는 개발 폴더) firebase-config.json ② 사용자 폴더에 저장된 값
function firebaseConfigPaths() {
  const list = [];
  if (app.isPackaged) list.push(path.join(path.dirname(process.execPath), 'firebase-config.json'));
  else list.push(path.join(__dirname, 'firebase-config.json'));
  list.push(path.join(app.getPath('userData'), 'firebase-config.json'));
  return list;
}
// 빌드할 때 넣어 둔 설정(build-config.json): Firebase 설정 + 고정 방 코드
function loadBuildConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-config.json'), 'utf8')); } catch { return {}; }
}
function loadFirebaseConfig() {
  const built = loadBuildConfig().firebase;
  if (built && built.apiKey && built.databaseURL) return built;
  for (const p of firebaseConfigPaths()) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (v && v.apiKey && v.databaseURL && !String(v.apiKey).includes('여기에')) return v;
    } catch { /* 없음 */ }
  }
  return null;
}

const ASSETS = path.join(__dirname, 'assets');
const APP_ICON = path.join(ASSETS, 'app_icon.png');
if (process.platform === 'win32') app.setAppUserModelId('com.pdroom.app'); // 작업표시줄에서 같은 앱으로 묶이게
let setupWin = null, petWin = null, settingsWin = null, tray = null;

const winIcon = () => nativeImage.createFromPath(APP_ICON);
const baseWeb = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true, nodeIntegration: false, sandbox: true,
  autoplayPolicy: 'no-user-gesture-required',
  backgroundThrottling: false,
};

function createSetup() {
  if (setupWin) { setupWin.show(); setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 640, height: 500, resizable: false, frame: false, transparent: true, show: false,
    title: '우가우가', icon: winIcon(), webPreferences: baseWeb,
  });
  setupWin.loadFile('setup.html');
  setupWin.once('ready-to-show', () => setupWin.show());
  setupWin.on('closed', () => { setupWin = null; if (!petWin && !quitting) app.quit(); });
  snapIfAsked(setupWin, 'setup');
}

function createPet() {
  const d = screen.getPrimaryDisplay();
  petWin = new BrowserWindow({
    // 작업표시줄을 가리지 않게 workArea만 덮고, 작업표시줄에는 프로그램 아이콘이 보이게 해요
    x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height,
    frame: false, transparent: true, resizable: false, movable: false, skipTaskbar: false,
    hasShadow: false, focusable: true, show: false, title: '우가우가', icon: winIcon(),
    webPreferences: baseWeb,
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.loadFile('pet.html');
  petWin.once('ready-to-show', () => petWin.showInactive());
  petWin.on('closed', () => { petWin = null; });
  petWin.webContents.on('did-finish-load', () => {
    if (idleNow) petWin.webContents.send('idle:changed', true);
    if (updateReadyVer) petWin.webContents.send('update:ready', updateReadyVer);
  });
  // 작업표시줄 아이콘을 눌러 최소화되면 캐릭터는 그대로 두고 설정 창을 열어요
  petWin.on('minimize', () => { setTimeout(() => { if (petWin) { petWin.restore(); petWin.showInactive(); } createSettings(); }, 50); });
  createTray();
  snapIfAsked(petWin, 'pet');
}

// 자리비움: 마우스·키보드를 3분 동안 안 쓰면 알려 줘요 (테스트용 PDROOM_IDLE_SEC)
const IDLE_SEC = Number(process.env.PDROOM_IDLE_SEC) || 180;
let idleNow = false;
setInterval(() => {
  if (!petWin) return;
  let t = 0; try { t = powerMonitor.getSystemIdleTime(); } catch { return; }
  const v = t >= IDLE_SEC;
  if (v !== idleNow) { idleNow = v; petWin.webContents.send('idle:changed', v); }
}, 5000);
function createSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 400, height: 720, resizable: false, frame: false, transparent: true, show: false,
    alwaysOnTop: true, title: '우가우가 설정', icon: winIcon(), webPreferences: baseWeb,
  });
  settingsWin.loadFile('settings.html');
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  snapIfAsked(settingsWin, 'settings');
}

function trayIcon() {
  const img = nativeImage.createFromPath(APP_ICON);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 32, height: 32 });
}
function trayMenu() {
  const hide = config.hide || {};
  return Menu.buildFromTemplate([
    { label: '우가우가', enabled: false },
    { type: 'separator' },
    { label: '방해금지', type: 'checkbox', checked: !!config.dnd, click: (i) => setConfig({ dnd: i.checked }) },
    { label: '그대로 멈춰라', type: 'checkbox', checked: !!config.freeze, click: (i) => setConfig({ freeze: i.checked }) },
    { label: '내 캐릭터 숨기기', type: 'checkbox', checked: !!hide.mine, click: (i) => setConfig({ hide: { ...(config.hide || {}), mine: i.checked } }) },
    { label: '모든 캐릭터 숨기기', type: 'checkbox', checked: !!hide.all, click: (i) => setConfig({ hide: { ...(config.hide || {}), all: i.checked } }) },
    { label: '소리', type: 'checkbox', checked: config.sound?.on !== false, click: (i) => setConfig({ sound: { ...(config.sound || {}), on: i.checked } }) },
    { type: 'separator' },
    { label: '설정', click: createSettings },
    { label: '종료', click: quitApp },
  ]);
}
function createTray() {
  if (tray) { tray.setImage(trayIcon()); tray.setContextMenu(trayMenu()); return; }
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('우가우가 v' + app.getVersion());
    tray.setContextMenu(trayMenu());
    tray.on('click', createSettings);
  } catch (e) { console.error('tray', e); }
}

function broadcast(ch, data) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, data);
}
function setConfig(patch) {
  Object.assign(config, patch);
  saveConfig();
  broadcast('config:changed', config);
  if (tray) { tray.setContextMenu(trayMenu()); }
  return config;
}

let quitting = false;
let updateReadyVer = null;
let installUpdateNow = () => quitApp();
function quitApp() {
  quitting = true;
  // 오버레이가 접속 표시를 지울 시간을 조금 줘요.
  if (petWin) { petWin.webContents.send('app:leaving'); setTimeout(() => app.quit(), 600); }
  else app.quit();
}

// 자동 실행(윈도우 로그인 시)
function getAutoLaunch() {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}
function setAutoLaunch(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch (e) { console.error(e); }
  return getAutoLaunch();
}

// ---------- IPC ----------
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e, patch) => setConfig(patch || {}));
ipcMain.handle('firebase:get', () => ({ config: loadFirebaseConfig(), emulator: process.env.PDROOM_EMU || null, room: loadBuildConfig().room || null }));
ipcMain.handle('firebase:save', (_e, cfg) => {
  const p = path.join(app.getPath('userData'), 'firebase-config.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return true;
});
ipcMain.handle('autolaunch:get', () => getAutoLaunch());
ipcMain.handle('autolaunch:set', (_e, on) => setAutoLaunch(on));
ipcMain.handle('screen:info', () => {
  const d = screen.getPrimaryDisplay();
  return { bounds: d.bounds, workArea: d.workArea };
});
ipcMain.on('pet:ignore', (_e, ignore) => {
  if (!petWin) return;
  petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
});
ipcMain.on('app:log', (_e, msg) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'log.txt'), `${new Date().toISOString()} ${msg}\n`); } catch { /* */ }
});
ipcMain.on('pet:focus', () => { if (petWin) petWin.focus(); });
ipcMain.on('win:close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); });
ipcMain.on('win:minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); });
ipcMain.on('settings:open', () => createSettings());
ipcMain.on('app:quit', () => quitApp());
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.on('update:install', () => installUpdateNow());
ipcMain.on('setup:done', (_e, data) => {
  setConfig(data);
  if (!petWin) createPet(); else petWin.reload();
  if (setupWin) { const w = setupWin; setupWin = null; w.close(); }
});
// 캐릭터·이름 바꾸기: 오버레이를 닫고 처음 화면으로
ipcMain.on('setup:restart', () => {
  setConfig({ char: null, uid: null });
  if (settingsWin) settingsWin.close();
  if (petWin) { const w = petWin; petWin = null; w.close(); }
  createSetup();
});

// ---------- 개발용 화면 캡처 ----------
function snapIfAsked(win, name) {
  const dir = process.env.PDROOM_SNAP;
  if (!dir) return;
  const delays = (process.env.PDROOM_SNAP_AT || '4000').split(',').map(Number);
  win.webContents.on('did-finish-load', () => {
    delays.forEach((ms, i) => setTimeout(async () => {
      if (win.isDestroyed()) return;
      const img = await win.webContents.capturePage();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${process.env.PDROOM_PROFILE || 'p'}_${name}_${i}.png`), img.toPNG());
    }, ms));
  });
}

app.on('second-instance', (_e, argv) => {
  if ((argv || []).includes('--quit')) { quitApp(); return; }
  if (setupWin) setupWin.focus(); else createSettings();
});
app.on('window-all-closed', () => { if (quitting || (!petWin && !setupWin)) app.quit(); });

// ---------- 자동 업데이트 (설치 파일로 깐 경우만) ----------
function startAutoUpdate() {
  if (!app.isPackaged || process.env.PDROOM_NO_UPDATE) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  const log = (m) => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'log.txt'), `${new Date().toISOString()} update ${m}\n`); } catch { /* */ } };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // 받아 두었다가 앱을 끌 때 설치 → 다음에 켜면 새 버전
  autoUpdater.on('error', (e) => log('error ' + (e && e.message)));
  autoUpdater.on('update-available', (i) => log('available ' + i.version));
  autoUpdater.on('update-downloaded', (i) => {
    log('downloaded ' + i.version);
    if (tray) tray.setToolTip(`우가우가 — 새 버전 ${i.version} 준비됨 (다음에 켜면 바뀌어요)`);
    updateReadyVer = i.version;
    if (petWin) petWin.webContents.send('update:ready', i.version);
  });
  installUpdateNow = () => {
    quitting = true;
    if (petWin) petWin.webContents.send('app:leaving');
    setTimeout(() => { try { autoUpdater.quitAndInstall(true, true); } catch (e) { log('install ' + e.message); app.quit(); } }, 600);
  };
  const check = () => autoUpdater.checkForUpdates().catch((e) => log('check ' + (e && e.message)));
  setTimeout(check, 15000);
  setInterval(check, 30 * 60 * 1000); // 30분마다 확인
}

app.whenReady().then(() => {
  // 작업표시줄 아이콘 오른쪽 클릭 메뉴에 '우가우가 끄기'를 넣어요
  if (process.platform === 'win32' && app.isPackaged) {
    try {
      app.setUserTasks([{ program: process.execPath, arguments: '--quit', iconPath: process.execPath, iconIndex: 0,
        title: '우가우가 끄기', description: '우가우가를 완전히 꺼요' }]);
    } catch { /* 무시 */ }
  }
  loadConfig();
  const fixedRoom = loadBuildConfig().room;
  if (fixedRoom && config.room !== fixedRoom) { config.room = fixedRoom; config.uid = null; config.char = null; saveConfig(); }
  if (config.room && config.uid && config.char && config.name) createPet();
  else createSetup();
  if (process.env.PDROOM_OPEN_SETTINGS) setTimeout(createSettings, 1500);
  startAutoUpdate();
});
