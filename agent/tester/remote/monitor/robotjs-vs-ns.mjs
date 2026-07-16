// Test 4: compare robotjs vs node-screenshots primary view.
// Run: node agent/tester/remote/monitor/robotjs-vs-ns.mjs
// robotjs getScreenSize() returns logical pixels of the PRIMARY monitor only,
// while node-screenshots Monitor.all() enumerates each display. Confirms the
// gap that makes monitor switching need node-screenshots, not robotjs.
import robotjs from "@hurdlegroup/robotjs";
import { Monitor } from "node-screenshots";

const robot = robotjs.default || robotjs;
const { width, height } = robot.getScreenSize();
console.log(`\n=== robotjs getScreenSize() ===`);
console.log(`logical: ${width}x${height}`);

const bmp = robot.screen.capture(0, 0, width, height);
const physW = bmp.byteWidth / bmp.bytesPerPixel;
console.log(`capture bitmap: ${physW}x${bmp.height} (bytesPerPixel=${bmp.bytesPerPixel})`);

const monitors = Monitor.all();
const primary = monitors.find((m) => m.isPrimary()) ?? monitors[0];
console.log(`\n=== node-screenshots primary ===`);
console.log(`id=${primary.id()} "${primary.name()}" ${primary.width()}x${primary.height()} scale=${primary.scaleFactor()}`);

console.log(`\n=== Summary ===`);
console.log(`robotjs sees:        ${width}x${height} logical (single screen)`);
console.log(`node-screenshots:    ${monitors.length} monitor(s), primary ${primary.width()}x${primary.height()}`);
console.log(`robotjs captures only primary → switching monitors MUST use node-screenshots index`);
