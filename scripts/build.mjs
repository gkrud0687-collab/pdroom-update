// src/*.js → dist/*.js 번들 + 포춘쿠키 문구 모으기
import { build } from 'esbuild';
import fs from 'node:fs';
const dir = 'assets/fortunes';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
const fortunes = files.map((f) => fs.readFileSync(`${dir}/${f}`, 'utf8').replace(/^﻿/, '').trim());
fs.mkdirSync('src/gen', { recursive: true });
fs.writeFileSync('src/gen/fortunes.json', JSON.stringify(fortunes, null, 1));
await build({
  entryPoints: ['src/setup.js', 'src/pet.js', 'src/settings.js'],
  bundle: true, format: 'iife', target: 'chrome130', outdir: 'dist',
  minify: process.argv.includes('--min'), sourcemap: !process.argv.includes('--min'), logLevel: 'warning',
});
console.log(`build ok (포춘 ${fortunes.length}개)`);
