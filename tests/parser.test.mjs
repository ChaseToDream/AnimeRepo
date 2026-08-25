// parser 单元测试（B-08）：零依赖，使用 Node 内置 test runner
// 运行：npm test（node --test tests/）
// 覆盖：常见命名模式解析、titleKey 规范化、自定义正则、「版」字清理回归
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFilename, parseWithRegex, titleKey, cleanTitlePart } from '../src/main/parser.js'

// —— cleanTitlePart ——
test('cleanTitlePart: 标题中独立的「版」字保留（B-08 回归）', () => {
  assert.equal(cleanTitlePart('我的版本故事'), '我的版本故事')
  assert.equal(cleanTitlePart('异世界版画师'), '异世界版画师')
})

test('cleanTitlePart: 版式整词（剧场版/特别版等）正常移除', () => {
  assert.equal(cleanTitlePart('剧场版 空之境界'), '空之境界')
  assert.equal(cleanTitlePart('特别篇 剧场版重制版'), '特别篇')
})

test('cleanTitlePart: 分辨率/编码噪声移除', () => {
  assert.equal(cleanTitlePart('标题 [1080p][x265]'), '标题')
})

// —— O-1：发布组方括号前缀剥离 ——
test('cleanTitlePart: 标题前导发布组标记被剥离（O-1）', () => {
  assert.equal(cleanTitlePart('[Nekomoe kissaten] Sora no Otoshimono'), 'Sora no Otoshimono')
  assert.equal(cleanTitlePart('[BD] [DATABASE] Some Anime'), 'Some Anime')
})

test('cleanTitlePart: 标题中段/结尾方括号不受影响（O-1 回归）', () => {
  const mid = parseFilename('My [Special] Title - 01.mkv', 'Folder')
  assert.equal(mid.animeTitle, 'My Special Title')
  assert.equal(mid.number, 1)
})

// —— parseFilename：常见命名模式 ——
test('parseFilename: [字幕组] 标题 - 01', () => {
  const r = parseFilename('[Nekomoe kissaten] Sora no Otoshimono - 05 [1080p].mkv', 'Library')
  assert.equal(r.animeTitle, 'Sora no Otoshimono')
  assert.equal(r.number, 5)
  assert.equal(r.season, 1)
})

test('parseFilename: 标题 S01E02', () => {
  const r = parseFilename('Some Anime S02E03.mkv', 'Folder')
  assert.equal(r.animeTitle, 'Some Anime')
  assert.equal(r.season, 2)
  assert.equal(r.number, 3)
})

test('parseFilename: 标题 第01话', () => {
  const r = parseFilename('某科学的超电磁炮 第12话.mp4', 'Folder')
  assert.equal(r.animeTitle, '某科学的超电磁炮')
  assert.equal(r.number, 12)
})

test('parseFilename: 标题 EP01', () => {
  const r = parseFilename('My Anime EP07 [720p].mp4', 'Folder')
  assert.equal(r.animeTitle, 'My Anime')
  assert.equal(r.number, 7)
})

test('parseFilename: 无法解析时 number=0 兜底', () => {
  const r = parseFilename('randomclip.mp4', 'MyFolder')
  assert.equal(r.number, 0)
  assert.equal(r.animeTitle, 'MyFolder')
})

test('parseFilename: 剧场版单文件', () => {
  const r = parseFilename('空之境界剧场版.mp4', 'Kara no Kyoukai')
  // 「剧场版」整词被清理；无集数 → number 0，标题回退目录名
  assert.equal(r.number, 0)
})

// —— titleKey ——
test('titleKey: 季/期后缀与标点归一', () => {
  assert.equal(titleKey('某番剧 第二季'), titleKey('某番剧'))
  assert.equal(titleKey('Re:Zero'), titleKey('ReZero'))
})

// —— parseWithRegex ——
test('parseWithRegex: 默认正则模式 [组] 标题 - 集数', () => {
  const r = parseWithRegex('[Group] Title - 12.mp4', '\\[(.*?)\\]\\s*(.+?)\\s*-\\s*(\\d+)')
  assert.equal(r.animeTitle, 'Group Title')
  assert.equal(r.number, 12)
})

test('parseWithRegex: 非法正则返回 null（回退启发式）', () => {
  assert.equal(parseWithRegex('Title - 01', '([invalid'), null)
})

test('parseWithRegex: 无数值捕获组返回 null', () => {
  assert.equal(parseWithRegex('Title - 01', '^(.+)$'), null)
})
