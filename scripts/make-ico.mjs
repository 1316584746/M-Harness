// 把 build/icon.png（256x256）包成 Windows 的 build/icon.ico（ICO 可以直接内嵌 PNG 数据）
import fs from "node:fs";

const png = fs.readFileSync("build/icon-256.png");
const head = Buffer.alloc(22);
head.writeUInt16LE(0, 0); // reserved
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(1, 4); // count
head.writeUInt8(0, 6); // width 0 = 256
head.writeUInt8(0, 7); // height 0 = 256
head.writeUInt8(0, 8); // colors
head.writeUInt8(0, 9);
head.writeUInt16LE(1, 10); // planes
head.writeUInt16LE(32, 12); // bpp
head.writeUInt32LE(png.length, 14);
head.writeUInt32LE(22, 18);
fs.writeFileSync("build/icon.ico", Buffer.concat([head, png]));
console.log("build/icon.ico", png.length + 22, "bytes");
