const fs=require('fs');
const D=__dirname;
let h=fs.readFileSync(D+'/shell.html','utf8');
const core=fs.readFileSync(D+'/core.js','utf8'), app=fs.readFileSync(D+'/app.js','utf8');
h=h.replace('/*CORE*/',()=>core).replace('/*APP*/',()=>app);
fs.writeFileSync(D+'/../index.html',h);
console.log('built index.html —',h.length,'bytes');
