// Tiny CDP evaluator for debugging the renderer.
// Usage: node scripts/cdp-eval.cjs <wsUrl> <jsExpression>
const WebSocket = require('/home/user/tabby/node_modules/ws')
const ws = new WebSocket(process.argv[2])
ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: process.argv[3],
    returnByValue: true,
    awaitPromise: true,
  }}))
})
ws.on('message', m => { console.log(m.toString()); ws.close() })
ws.on('error', e => { console.error(e.message); process.exit(1) })
