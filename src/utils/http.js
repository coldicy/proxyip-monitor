// 请求体读取（源 server.js:204-212）
function readBody(q, max) {
max = max || 5 * 1024 * 1024;
return new Promise((res, rej) => {
let d = '';
q.on('data', c => { d += c; if (d.length > max) { rej(new Error('请求体过大')); q.destroy(); } });
q.on('end', () => res(d));
q.on('error', rej);
});
}
module.exports = { readBody };
