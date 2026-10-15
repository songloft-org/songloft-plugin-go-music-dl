// 歌词格式工具：判别/折叠 go-music-dl 的 karaoke（多时间戳）LRC，
// 并转换为宿主 Songloft 逐字解析器支持的「绝对单尖括号」格式。
//
// 背景：
// - 上游 go-music-dl 对网易云/QQ/酷狗返回逐字 karaoke LRC（一行多时间戳或
//   多行共用起始时间戳，见 internal/web/lyrics_format.go classifyLyricFormat），
//   其 /download_lrc?format=line 可在服务端折叠为逐行 LRC。
// - 宿主 LyricParser.parseWordByWord 支持三种逐字标记（lib/features/player/
//   domain/lyric_parser.dart）：洛雪相对 `<off,dur>`、绝对双括号 `[[mm:ss.xx]]`、
//   绝对单尖括号 `<mm:ss.xx>`。多时间戳「整行重复」形态会被宿主普通解析拆成
//   重复行，因此 lyric 字段必须用折叠后的逐行版，逐字信息单独放 lxlyric。
// - 分类/折叠语义与上游 lyrics_format.go 对齐（纯函数，便于测试对齐）。

/** 与上游 lrcTimestampRe 一致：[mm:ss.xxx]，分钟/秒可 1+ 位，毫秒 1-3 位 */
const LRC_TS_RE = /\[(\d+):(\d+)\.(\d{1,3})\]/g
/** 元数据标签行：[ti:] / [ar:] 等（不含纯时间戳，因为标签值非数字） */
const LRC_TAG_LINE_RE = /^\[[A-Za-z]+:[^\]]*\]$/

interface TsMatch {
  index: number
  raw: string
  min: string
  sec: string
  ms: string
}

function scanTimestamps(line: string): TsMatch[] {
  LRC_TS_RE.lastIndex = 0
  const matches: TsMatch[] = []
  let m: RegExpExecArray | null
  while ((m = LRC_TS_RE.exec(line))) {
    matches.push({
      index: m.index,
      raw: m[0],
      min: m[1],
      sec: m[2],
      ms: m[3],
    })
  }
  return matches
}

/** 判别歌词格式：任一行含多个时间戳、或多行共用同一起始时间戳 → karaoke。 */
export function classifyLyricFormat(raw: string): 'karaoke' | 'line' {
  const startCounts = new Map<string, number>()
  for (const rawLine of (raw || '').split('\n')) {
    const line = rawLine.trim()
    if (!line || LRC_TAG_LINE_RE.test(line)) continue
    const matches = scanTimestamps(line)
    if (!matches.length) continue
    if (matches.length > 1) return 'karaoke'
    const start = matches[0].raw
    const count = (startCounts.get(start) || 0) + 1
    if (count > 1) return 'karaoke'
    startCounts.set(start, count)
  }
  return 'line'
}

/**
 * 把 karaoke LRC 折叠为「一行一个时间戳」的逐行 LRC。
 * 语义与上游 lyrics_format.go lyricOriginalLineOnly 一致：
 * 保留元数据标签行；每个起始时间戳只保留一次（多标签行/逐字行折叠为
 * 第一个时间戳 + 去时间戳后的全文）；按起始时间戳字符串排序。
 */
export function collapseKaraokeToLines(raw: string): string {
  const seenStarts = new Set<string>()
  const tags: string[] = []
  const lines: { start: string; text: string }[] = []
  for (const rawLine of (raw || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (LRC_TAG_LINE_RE.test(line)) {
      tags.push(line)
      continue
    }
    const matches = scanTimestamps(line)
    if (!matches.length) continue
    const start = matches[0].raw
    if (seenStarts.has(start)) continue
    seenStarts.add(start)
    const text = line.replace(LRC_TS_RE, '').trim()
    if (!text) continue
    lines.push({ start, text })
  }
  lines.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  const out: string[] = [...tags]
  if (tags.length && lines.length) out.push('')
  for (const l of lines) out.push(l.start + l.text)
  return out.join('\n')
}

/** 宿主逐字标记要求 mm 1-2 位、ss 2 位、毫秒 1-3 位；超界规整（防御性）。 */
function fmtAngleTs(t: TsMatch): string {
  const mm = String(Math.min(99, parseInt(t.min, 10) || 0)).padStart(2, '0')
  const ss = String(Math.min(99, parseInt(t.sec, 10) || 0)).padStart(2, '0')
  return `<${mm}:${ss}.${t.ms}>`
}

function fmtLineTs(t: TsMatch): string {
  const mm = String(Math.min(99, parseInt(t.min, 10) || 0)).padStart(2, '0')
  const ss = String(Math.min(99, parseInt(t.sec, 10) || 0)).padStart(2, '0')
  return `[${mm}:${ss}.${t.ms}]`
}

/**
 * 把 karaoke LRC 转为宿主「绝对单尖括号」逐字格式：
 *   [mm:ss.xx]<mm:ss.xx>字<mm:ss.xx>字...
 * - 交错逐字行（[t1]w1[t2]w2...）：每个非空文本段配其时间标记，
 *   连续空段时间戳归并到下一个非空段（取更早的起始时间）。
 * - 行首多标签行（[t1][t2]整句，非逐字）：折叠为 [t1]整句（普通行）。
 * - 单时间戳行 / 元数据标签行：原样保留。
 * 输出可直接作为 LyricPayload.lxlyric，由宿主 parseWordByWord 解析；
 * 解析不了的行会自动降级为普通行，不会破坏渲染。
 */
export function karaokeToLxLyric(raw: string): string {
  const out: string[] = []
  for (const rawLine of (raw || '').split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (LRC_TAG_LINE_RE.test(line)) {
      out.push(line)
      continue
    }
    const matches = scanTimestamps(line)
    if (matches.length <= 1) {
      out.push(line)
      continue
    }
    // 各时间戳与其后至下一时间戳（或行尾）之间的文本段
    const segs = matches.map((t, i) => {
      const from = t.index + t.raw.length
      const to = i + 1 < matches.length ? matches[i + 1].index : line.length
      return { ts: t, text: line.slice(from, to).trim() }
    })
    const interleaved = segs.slice(0, -1).some((s) => s.text.length > 0)
    if (!interleaved) {
      // 行首多标签的普通行：折叠为首标签 + 全文（与 collapse 对齐）
      const text = segs.map((s) => s.text).join('').trim()
      if (!text) continue
      out.push(fmtLineTs(matches[0]) + text)
      continue
    }
    const body: string[] = []
    let pending: TsMatch | null = null
    for (const seg of segs) {
      if (seg.text) {
        const ts = pending ?? seg.ts
        body.push(`${fmtAngleTs(ts)}${seg.text}`)
        pending = null
      } else if (!pending) {
        pending = seg.ts
      }
    }
    if (!body.length) continue
    out.push(fmtLineTs(matches[0]) + body.join(''))
  }
  return out.join('\n')
}
