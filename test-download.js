import http from 'http';
http.get({
  hostname: 'localhost',
  port: 3000,
  path: '/api/download/123'
}, (res) => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'DATA:', data));
});
