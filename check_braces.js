const fs = require('fs');
const content = fs.readFileSync('js/app.js', 'utf8');

let braceCount = 0;
let inString = false;
let stringChar = '';
let inComment = false;
let inMultiComment = false;

const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    const nextChar = line[j+1] || '';
    
    if (!inString && !inComment && !inMultiComment) {
      if (char === '/' && nextChar === '/') {
        inComment = true;
        break;
      }
      if (char === '/' && nextChar === '*') {
        inMultiComment = true;
        j++;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        inString = true;
        stringChar = char;
        continue;
      }
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount < 0) {
           console.log(`Negative brace count at line ${i + 1}`);
           process.exit(1);
        }
      }
    } else if (inString) {
      if (char === '\\') j++;
      else if (char === stringChar) inString = false;
    } else if (inMultiComment) {
      if (char === '*' && nextChar === '/') {
        inMultiComment = false;
        j++;
      }
    }
  }
  inComment = false; // reset for new line
  
  if (i === 4649) {
     console.log(`Brace count at line 4650 is ${braceCount}`);
  }
}
console.log(`Final brace count: ${braceCount}`);
