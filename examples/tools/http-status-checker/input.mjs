// URLs to check. Edit this list, then run:
//   node examples/tools/http-status-checker/sequential.mjs
//   node examples/tools/http-status-checker/bulk.mjs
//
// Where URLs come from (first match wins):
//   1. URLs passed on the command line
//   2. this list, when it isn't empty
//   3. an offline demo with 50 local URLs (or always, with --demo)
export const urls = [
  'https://example.com',
  'https://httpbin.org/status/301',
  'https://httpbin.org/status/302',
  'https://httpbin.org/status/404',
  'https://httpbin.org/status/500',
  'https://httpbin.org/status/200',
  'https://httpbin.org/status/403',
  'https://httpbin.org/status/307',
  'https://httpbin.org/status/308',
];
