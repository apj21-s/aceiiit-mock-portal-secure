const fs = require('fs');
const code = fs.readFileSync('/home/arco/Documents/aceiiit-mock-portal-secure/js/app.js', 'utf8');
try {
  new Function(code);
  console.log("SYNTAX_OK");
} catch(err) {
  console.error("SYNTAX_ERROR:", err.message);
}
