import * as path from 'path'
import * as url from 'url'
import baseConfig from '../tabby/webpack.plugin.config.mjs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const TABBY_ROOT = path.resolve(__dirname, '..', 'tabby')

export default () => {
  const cfg = baseConfig({ name: 'input-broker', dirname: __dirname })

  // Re-point module resolution at Tabby's installed deps so we don't
  // have to duplicate the full Angular toolchain in our own node_modules.
  cfg.resolve.modules = [
    __dirname,                                       // resolve `src/index.ts` entry
    path.join(__dirname, 'src'),
    path.join(__dirname, 'node_modules'),
    path.join(TABBY_ROOT, 'app', 'node_modules'),
    path.join(TABBY_ROOT, 'node_modules'),
  ]

  // Loaders (@ngtools/webpack, babel-loader, etc.) live in Tabby's tree.
  cfg.resolveLoader = {
    modules: [
      path.join(__dirname, 'node_modules'),
      path.join(TABBY_ROOT, 'app', 'node_modules'),
      path.join(TABBY_ROOT, 'node_modules'),
    ],
  }

  return cfg
}
