import http from 'http';
http.get('http://localhost:3000', (res) => {
  console.log('STATUS:', res.statusCode);
}).on('error', e => console.error(e));
