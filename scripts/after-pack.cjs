// 윈도우 exe에 아이콘과 이름을 넣어요 (Wine 없이 resedit 사용)
const fs = require('fs');
const path = require('path');
module.exports = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const R = ResEdit.default || ResEdit, P = PE.default || PE;
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const data = fs.readFileSync(exe);
  const exeObj = P.NtExecutable.from(data, { ignoreCert: true });
  const res = P.NtExecutableResource.from(exeObj);
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const old = R.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = old.length ? old[0].id : 1, lang = old.length ? old[0].lang : 1033;
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const version = ctx.packager.appInfo.version;
    const [a, b, c] = version.split('.').map(Number);
    vi.setFileVersion(a, b, c, 0); vi.setProductVersion(a, b, c, 0);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      FileDescription: '우가우가', ProductName: '우가우가', CompanyName: '우가우가',
      OriginalFilename: 'PDRoom.exe', InternalName: 'PDRoom', LegalCopyright: '',
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exeObj);
  fs.writeFileSync(exe, Buffer.from(exeObj.generate()));
  console.log('  • exe 아이콘·이름 넣음', exe);
};
