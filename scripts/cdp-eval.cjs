// Tiny CDP evaluator for debugging the renderer.
// Usage: node scripts/cdp-eval.cjs <wsUrl> <jsExpression>
// Uses Node's native WebSocket (Node 22+).
const ws = new WebSocket(process.argv[2])
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: process.argv[3],
    returnByValue: true,
    awaitPromise: true,
  }}))
})
ws.addEventListener('message', m => { console.log(m.data); ws.close() })
ws.addEventListener('error', () => { console.error('cdp websocket error'); process.exit(1) })
