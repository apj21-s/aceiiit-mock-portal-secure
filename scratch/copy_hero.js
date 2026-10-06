const fs = require('fs');
const src = '/home/arco/.gemini/antigravity/brain/17200e45-9ef1-4c9d-8c4e-348590fc8266/aceiiit_student_hero_1788196728874.png';
const dest = '/home/arco/Documents/aceiiit-mock-portal-secure/assets/aceiiit_student_hero.png';

try {
  fs.copyFileSync(src, dest);
  console.log("COPY_SUCCESS");
} catch(e) {
  console.error("COPY_FAILED:", e.message);
}
