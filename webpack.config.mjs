import * as url from 'url'
import config from '../tabby/webpack.plugin.config.mjs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

export default () => config({
  name: 'input-broker',
  dirname: __dirname,
})
