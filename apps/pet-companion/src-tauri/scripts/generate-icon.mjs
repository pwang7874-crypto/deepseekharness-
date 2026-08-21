import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const size = 512
const raw = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1); raw[row] = 0
  for (let x = 0; x < size; x++) {
    const i = row + 1 + x * 4
    const dx = x - 256, dy = y - 270
    const head = dx * dx / 175 ** 2 + dy * dy / 154 ** 2 < 1
    const leftEar = ((x - 155) / 80) ** 2 + ((y - 135) / 105) ** 2 < 1 && y < 215
    const rightEar = ((x - 357) / 80) ** 2 + ((y - 135) / 105) ** 2 < 1 && y < 215
    const eye = (((x - 190) / 18) ** 2 + ((y - 275) / 28) ** 2 < 1) || (((x - 322) / 18) ** 2 + ((y - 275) / 28) ** 2 < 1)
    const mouth = y > 330 && y < 346 && Math.abs(Math.abs(x - 256) - (y - 330) * 1.6) < 7
    let r = 255 - Math.round(y * .18), g = 150 - Math.round(y * .08), b = 198 + Math.round(y * .08)
    if (head || leftEar || rightEar) [r, g, b] = [255, 242, 250]
    if (eye || mouth) [r, g, b] = [86, 51, 93]
    raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const chunk = (type, data) => {
  const name = Buffer.from(type), body = Buffer.concat([name, data]); let crc = 0xffffffff
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8); return out
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
writeFileSync(new URL('../icons/icon.png', import.meta.url), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
